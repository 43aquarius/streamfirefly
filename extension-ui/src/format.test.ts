import { sourceLabel } from "./format";

describe("source labels", () => {
  it("names page-probe sources by where the address was found", () => {
    expect(sourceLabel("dom")).toBe("页面元素");
    expect(sourceLabel("network")).toBe("网络响应");
    expect(sourceLabel("timing")).toBe("资源记录");
    expect(sourceLabel("rule")).toBe("提取规则");
    expect(sourceLabel("xhr-json")).toBe("请求响应体");
    expect(sourceLabel("xhr-body")).toBe("请求响应体");
    expect(sourceLabel("fetch-body")).toBe("请求响应体");
    expect(sourceLabel("xhr")).toBe("页面请求");
    expect(sourceLabel("fetch")).toBe("页面请求");
    expect(sourceLabel("xhr-body-member")).toBe("清单成员");
    expect(sourceLabel("inline-script")).toBe("页面脚本");
    expect(sourceLabel("page-probe-text")).toBe("页面脚本");
    expect(sourceLabel("blob-body")).toBe("内存数据");
    expect(sourceLabel("blob-manifest")).toBe("内存清单");
    expect(sourceLabel("")).toBe("其他来源");
    expect(sourceLabel("something-new")).toBe("其他来源");
  });
});
