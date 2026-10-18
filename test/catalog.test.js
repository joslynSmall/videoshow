import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import {
  acceptPageUrl,
  loadCatalogTitle,
  mapSearchPayload,
  searchCatalog,
} from "../src/catalog.js";

test("acceptPageUrl keeps platform pages and drops 360 catalog pages", () => {
  assert.equal(
    acceptPageUrl("https://www.iqiyi.com/v_1.html"),
    "https://www.iqiyi.com/v_1.html",
  );
  assert.equal(acceptPageUrl("//v.qq.com/x/cover/abc.html"), "https://v.qq.com/x/cover/abc.html");
  assert.equal(acceptPageUrl("https://www.360kan.com/tv/abc"), null);
  assert.equal(acceptPageUrl("https://tv.360kan.com/tv/abc"), null);
  assert.equal(acceptPageUrl("javascript:alert(1)"), null);
  assert.equal(acceptPageUrl(""), null);
});

test("mapSearchPayload maps title cards and platform names", () => {
  const items = mapSearchPayload({
    data: {
      longData: {
        rows: [
          {
            titleTxt: "狂飙",
            en_id: "abc",
            cat_id: "2",
            cat_name: "电视剧",
            year: "2023",
            cover: "https://img.example/cover.jpg",
            description: "<p>简介</p>",
            url: "https://www.360kan.com/tv/abc",
            seriesSite: "qq",
            playlinks: { qiyi: "www.iqiyi.com", qq: "v.qq.com" },
          },
          { titleTxt: "", en_id: "skip", cat_id: "2" },
        ],
      },
    },
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "abc");
  assert.equal(items[0].cat, "2");
  assert.equal(items[0].title, "狂飙");
  assert.equal(items[0].desc, "简介");
  assert.deepEqual(
    items[0].platforms.map((item) => item.name),
    ["爱奇艺", "腾讯视频"],
  );
  assert.equal(items[0].platforms[0].id, "qiyi");
});

test("searchCatalog rejects a blank keyword and wraps upstream failures", async () => {
  await assert.rejects(
    () => searchCatalog("  "),
    (err) => err instanceof AppError && err.status === 400 && err.code === "INVALID_KEYWORD",
  );
  await assert.rejects(
    () =>
      searchCatalog("狂飙", {
        searchUrl: "https://catalog.example/index",
        fetchJsonFn: async () => {
          throw new Error("down");
        },
      }),
    (err) =>
      err instanceof AppError &&
      err.status === 502 &&
      err.code === "CATALOG_UPSTREAM_ERROR",
  );
});

test("loadCatalogTitle pages short episode lists and drops catalog hosts", async () => {
  const calls = [];
  const fetchJsonFn = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.searchParams.get("start")) {
      return {
        data: {
          allepidetail: {
            qiyi: [
              { playlink_num: "1", url: "https://www.iqiyi.com/v_1.html" },
              { playlink_num: "2", url: "https://www.360kan.com/tv/2" },
              { playlink_num: "3", url: "https://www.iqiyi.com/v_3.html" },
            ],
          },
        },
      };
    }
    return {
      data: {
        title: "测试剧",
        description: "目录简介",
        playlink_sites: ["qiyi"],
        allupinfo: { qiyi: 3 },
        allepidetail: {
          qiyi: [{ playlink_num: "1", url: "https://www.iqiyi.com/v_1.html" }],
        },
      },
    };
  };

  const result = await loadCatalogTitle("2", "abc", {
    detailUrl: "https://catalog.example/v1/detail",
    fetchJsonFn,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1], /start=1/);
  assert.match(calls[1], /end=3/);
  assert.match(calls[1], /site=qiyi/);
  assert.equal(result.title, "测试剧");
  assert.equal(result.platforms.length, 1);
  assert.equal(result.platforms[0].name, "爱奇艺");
  assert.deepEqual(
    result.platforms[0].episodes.map((item) => item.name),
    ["第1集", "第3集"],
  );
  assert.equal(result.platforms[0].episodes[0].pageUrl, "https://www.iqiyi.com/v_1.html");
});

test("loadCatalogTitle uses the movie page when a site has no episodes", async () => {
  const result = await loadCatalogTitle("1", "movie", {
    detailUrl: "https://catalog.example/v1/detail",
    fetchJsonFn: async () => ({
      data: {
        title: "测试电影",
        playlink_sites: ["qq", "qiyi"],
        playlinksdetail: {
          qq: { default_url: "https://v.qq.com/x/cover/abc.html" },
          qiyi: { default_url: "https://www.iqiyi.com/v_movie.html" },
        },
      },
    }),
  });

  assert.deepEqual(
    result.platforms.map((item) => item.id),
    ["qiyi", "qq"],
  );
  assert.equal(result.platforms[0].episodes[0].name, "正片");
  assert.equal(result.platforms[0].episodes[0].pageUrl, "https://www.iqiyi.com/v_movie.html");
});

test("loadCatalogTitle rejects a missing id", async () => {
  await assert.rejects(
    () => loadCatalogTitle("2", ""),
    (err) => err instanceof AppError && err.status === 400 && err.code === "INVALID_TITLE",
  );
});
