use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Instant;
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Track {
    pub(crate) generation: u32,
    pub(crate) id: u32,
    pub(crate) mime: String,
    pub(crate) bytes: u64,
    pub(crate) next_sequence: u64,
    pub(crate) last_chunk_size: u64,
    pub(crate) initialized: bool,
    pub(crate) file: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Snapshot {
    pub(crate) version: u8,
    pub(crate) id: String,
    pub(crate) state: String,
    pub(crate) bytes: u64,
    pub(crate) tracks: Vec<Track>,
    pub(crate) output: Option<String>,
    pub(crate) outputs: Vec<String>,
    pub(crate) error: Option<String>,
    #[serde(default, rename = "createdAt")]
    pub(crate) created_at: u64,
    #[serde(default, rename = "pageTitle", skip_serializing_if = "Option::is_none")]
    pub(crate) page_title: Option<String>,
    #[serde(default, rename = "pageUrl", skip_serializing_if = "Option::is_none")]
    pub(crate) page_url: Option<String>,
}

/// Progress of the segment being merged; shown to the user, never saved.
#[derive(Clone, Serialize)]
pub(crate) struct MergeProgress {
    pub(crate) segment: usize,
    pub(crate) segments: usize,
    #[serde(rename = "processedBytes")]
    pub(crate) processed_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub(crate) total_bytes: u64,
    #[serde(rename = "idleSeconds")]
    pub(crate) idle_seconds: u64,
}

/// State that only lives while the helper runs; listed with the snapshot but kept out of capture.json.
#[derive(Default)]
pub(crate) struct Runtime {
    pub(crate) merge: Option<MergeProgress>,
    pub(crate) free_bytes: Option<u64>,
    pub(crate) free_checked: Option<Instant>,
}

pub(crate) struct Session {
    pub(crate) snapshot: Snapshot,
    pub(crate) directory: PathBuf,
    pub(crate) stop: bool,
    pub(crate) worker_active: bool,
    pub(crate) runtime: Runtime,
}
