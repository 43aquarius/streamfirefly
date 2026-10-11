use crate::media_process::set_output_state;
use crate::model::Task;
use crate::repository::{persist_tasks, sanitized_task};
use crate::runtime::{host_exiting, TaskRuntime};
use crate::task_input::reserve_task_output;
use crate::wire::{emit, Writer};
use serde_json::json;
use std::{fs, path::Path, sync::{RwLockReadGuard, atomic::Ordering}};

pub(crate) struct HlsPublication<'a> {
    store: &'a TaskRuntime,
    writer: Option<&'a Writer>,
    id: &'a str,
    _permit: RwLockReadGuard<'a, ()>,
}

impl<'a> HlsPublication<'a> {
    pub(crate) fn begin(store: &'a TaskRuntime, writer: Option<&'a Writer>, id: &'a str) -> Result<Self, &'static str> {
        let permit = store.publications.read().map_err(|_| "publication_unavailable")?;
        if host_exiting(store) { return Err("host_stopping"); }
        Ok(Self { store, writer, id, _permit: permit })
    }

    pub(crate) fn publish(&self, kind: &str, index: usize, source: &Path, destination: &Path) -> Result<(), &'static str> {
        self.publish_with(kind, index, source, destination, |source, destination| {
            std::io::copy(source, destination)?;
            destination.sync_all()
        })
    }

    fn publish_with(&self, kind: &str, index: usize, source: &Path, destination: &Path,
        write: impl FnOnce(&mut fs::File, &mut fs::File) -> std::io::Result<()>) -> Result<(), &'static str> {
        let mut pending = {
            let tasks = self.store.repository.tasks.lock().unwrap();
            reserve_task_output(source, destination, &tasks, self.id)?
        };
        let copy_result = pending.write_with(write);
        if copy_result.is_err() {
            if pending.discard().is_err() { self.store.publication_failed.store(true, Ordering::Relaxed); }
            return Err("output_write_failed");
        }
        self.update(|task| {
            set_output_state(task, kind, index, "succeeded", None);
            if task.outputs.iter().all(|output| output.state == "succeeded") {
                complete(task);
                task.checkpoint_state = Some("recoverable".into());
            }
        })?;
        pending.commit();
        Ok(())
    }

    pub(crate) fn update(&self, change: impl FnOnce(&mut Task)) -> Result<(), &'static str> {
        let mut tasks = self.store.repository.tasks.lock().unwrap();
        let task = tasks.iter_mut().find(|task| task.id == self.id).ok_or("task_not_found")?;
        let previous = task.clone();
        change(task);
        task.revision = task.revision.saturating_add(1);
        let public = sanitized_task(task);
        if persist_tasks(&self.store.repository, &tasks).is_err() {
            *tasks.iter_mut().find(|task| task.id == self.id).unwrap() = previous;
            self.store.publication_failed.store(true, Ordering::Relaxed);
            drop(tasks);
            if let Some(writer) = self.writer {
                emit(writer, json!({"version":1,"type":"task.persistence-error","id":self.id,"error":"task_store_write_failed"}));
            }
            return Err("task_store_write_failed");
        }
        drop(tasks);
        if let Some(writer) = self.writer { emit(writer, json!({"version":1,"type":"task.progress","task":public})); }
        Ok(())
    }

    pub(crate) fn finish(&self, work: &Path) -> Result<(), &'static str> {
        self.update(|task| {
            complete(task);
            task.checkpoint_state = Some("recoverable".into());
        })?;
        if fs::remove_dir_all(work).is_ok() {
            self.update(|task| task.checkpoint_state = Some("cleaned".into()))?;
        }
        Ok(())
    }
}

fn complete(task: &mut Task) {
    task.state = "succeeded".into();
    task.phase = "completed".into();
    task.progress = 100;
    task.active_connections = 0;
    task.eta_seconds = Some(0);
    task.resume_requirement = None;
    task.error = None;
    task.message = Some(if task.live_recording { "直播录制已停止并保存" } else { "HLS 视频和所选字幕下载完成" }.into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{runtime::load_store, task_creation::create_task};
    use std::{sync::{mpsc, atomic::Ordering}, thread, time::Duration};
    use uuid::Uuid;

    fn fixture() -> (std::path::PathBuf, TaskRuntime, Task) {
        let root = std::env::temp_dir().join(format!("streamfirefly-publication-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work")).unwrap();
        fs::write(root.join("work/media.tmp"), b"complete-media").unwrap();
        fs::write(root.join("work/checkpoint.json"), b"checkpoint").unwrap();
        let store = load_store(&root.join("tasks.json"));
        let task: Task = serde_json::from_value(json!({"id":"publishing","url":"https://example.test/video.m3u8","title":"movie","mime":"application/vnd.apple.mpegurl","state":"running","progress":90,"output":root.join("movie.mkv"),"error":null,"hls_selection":true,"hls_plan_version":2,"outputs":[{"kind":"media","path":root.join("movie.mkv"),"state":"running","error":null}]})).unwrap();
        store.repository.tasks.lock().unwrap().push(task.clone());
        crate::repository::save_store(&store.repository).unwrap();
        (root, store, task)
    }

    #[test]
    fn publication_does_not_hold_the_task_map_during_copy() {
        let (root, store, task) = fixture();
        let worker_store = store.clone();
        let worker_root = root.clone();
        let (started, ready) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let worker = thread::spawn(move || {
            let owner = HlsPublication::begin(&worker_store, None, &task.id).unwrap();
            owner.publish_with("media", 0, &worker_root.join("work/media.tmp"), Path::new(task.output.as_ref().unwrap()), |source, output| {
                started.send(()).unwrap(); resume.recv_timeout(Duration::from_secs(5)).unwrap();
                std::io::copy(source, output)?; output.sync_all()
            })
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        let query_available = store.repository.tasks.try_lock().is_ok();
        let created = if query_available {
            Some(create_task(&store, &json!({"url":"https://example.test/other.mkv","fileName":"movie","saveDir":root,"mime":"video/x-matroska"})).unwrap())
        } else { None };
        release.send(()).unwrap();
        worker.join().unwrap().unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert!(query_available, "bulk copy held the global task map");
        assert_eq!(created.unwrap().output, Some(root.join("movie (1).mkv").to_string_lossy().into_owned()));
    }

    #[test]
    fn eof_waits_for_copy_and_persists_completion_before_checkpoint_cleanup() {
        let (root, store, task) = fixture();
        let worker_store = store.clone();
        let worker_root = root.clone();
        let (started, ready) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let worker = thread::spawn(move || {
            let owner = HlsPublication::begin(&worker_store, None, &task.id).unwrap();
            owner.publish_with("media", 0, &worker_root.join("work/media.tmp"), Path::new(task.output.as_ref().unwrap()), |source, output| {
                started.send(()).unwrap(); resume.recv_timeout(Duration::from_secs(5)).unwrap();
                std::io::copy(source, output)?; output.sync_all()
            }).unwrap();
            owner.finish(&worker_root.join("work")).unwrap();
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        let stopping_store = store.clone();
        let (stopped, finished) = mpsc::channel();
        let stopper = thread::spawn(move || {
            stopping_store.exiting.store(true, Ordering::SeqCst);
            stopped.send(crate::protocol::shutdown_downloads(&stopping_store)).unwrap();
        });
        let waited = finished.recv_timeout(Duration::from_millis(100)).is_err();
        release.send(()).unwrap(); worker.join().unwrap(); stopper.join().unwrap();
        if waited { finished.recv_timeout(Duration::from_secs(5)).unwrap().unwrap(); }
        let persisted: serde_json::Value = serde_json::from_slice(&fs::read(root.join("tasks.json")).unwrap()).unwrap();
        let state = persisted["tasks"][0]["state"].as_str().unwrap().to_owned();
        let checkpoint_exists = root.join("work/checkpoint.json").exists();
        assert_eq!(fs::read(root.join("movie.mkv")).unwrap(), b"complete-media");
        fs::remove_dir_all(root).unwrap();
        assert!(waited, "EOF returned before the active publication settled");
        assert_eq!(state, "succeeded", "EOF lost the published output's durable completion");
        assert!(!checkpoint_exists);
    }

    #[test]
    fn completion_save_failure_retains_checkpoint() {
        let (root, store, task) = fixture();
        fs::create_dir(store.repository.path.with_extension("tmp")).unwrap();
        let result = {
            let owner = HlsPublication::begin(&store, None, &task.id).unwrap();
            owner.finish(&root.join("work"))
        };
        let retained = root.join("work/checkpoint.json").exists();
        fs::remove_dir_all(root).unwrap();
        assert!(result.is_err());
        assert!(retained, "completion save failure deleted the checkpoint");
    }

    #[test]
    fn publication_save_failure_discards_only_its_output_and_reports_shutdown_failure() {
        let (root, store, task) = fixture();
        fs::write(root.join("unrelated.mkv"), b"original").unwrap();
        fs::create_dir(store.repository.path.with_extension("tmp")).unwrap();
        let result = {
            let owner = HlsPublication::begin(&store, None, &task.id).unwrap();
            owner.publish("media", 0, &root.join("work/media.tmp"), &root.join("movie.mkv"))
        };
        assert_eq!(result, Err("task_store_write_failed"));
        assert!(!root.join("movie.mkv").exists());
        assert_eq!(fs::read(root.join("unrelated.mkv")).unwrap(), b"original");
        assert!(root.join("work/media.tmp").exists());
        assert!(root.join("work/checkpoint.json").exists());
        assert_eq!(store.repository.tasks.lock().unwrap()[0].state, "running");
        assert_eq!(crate::protocol::shutdown_downloads(&store), Err("publication_cleanup_failed".into()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn eof_preserves_published_media_and_pending_subtitle_recovery() {
        let (root, store, task) = fixture();
        {
            let mut tasks = store.repository.tasks.lock().unwrap();
            let mut subtitle = tasks[0].outputs[0].clone();
            subtitle.kind = "subtitle".into();
            subtitle.state = "queued".into();
            subtitle.path = Some(root.join("movie.en.vtt").to_string_lossy().into_owned());
            tasks[0].outputs.push(subtitle);
            persist_tasks(&store.repository, &tasks).unwrap();
        }
        {
            let owner = HlsPublication::begin(&store, None, &task.id).unwrap();
            store.exiting.store(true, Ordering::SeqCst);
            owner.publish("media", 0, &root.join("work/media.tmp"), &root.join("movie.mkv")).unwrap();
        }
        crate::protocol::shutdown_downloads(&store).unwrap();
        assert!(HlsPublication::begin(&store, None, &task.id).is_err());
        let persisted: serde_json::Value = serde_json::from_slice(&fs::read(root.join("tasks.json")).unwrap()).unwrap();
        assert_eq!(persisted["tasks"][0]["outputs"][0]["state"], "succeeded");
        assert_eq!(persisted["tasks"][0]["outputs"][1]["state"], "queued");
        assert_ne!(persisted["tasks"][0]["state"], "succeeded");
        assert!(root.join("work/checkpoint.json").exists());
        assert!(!root.join("movie.en.vtt").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
