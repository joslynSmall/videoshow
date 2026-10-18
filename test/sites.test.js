import assert from "node:assert/strict";
import test from "node:test";
import { mapBilibiliSearch } from "../src/sites/impl/bilibili.js";
import { iqiyiTvId, mapIqiyiAvlist, mapIqiyiSearch } from "../src/sites/impl/iqiyi.js";
import { mapMgtvPage, mapMgtvSearch } from "../src/sites/impl/mgtv.js";
import { mapQqEpisodeIds, mapQqSearch, qqCoverId } from "../src/sites/impl/qq.js";
import { mapYoukuEpisodes, youkuShowId } from "../src/sites/impl/youku.js";
import { mapMgtvEpisodes, mgtvVideoId } from "../src/sites/impl/mgtv.js";
import { mapBilibiliSeason } from "../src/sites/impl/bilibili.js";
import { searchSites } from "../src/sites/index.js";
import { mapYoukuSearch } from "../src/sites/impl/youku.js";

test("mapIqiyiSearch keeps album pages and drops short clips", () => {
  const items = mapIqiyiSearch({
    data: {
      templates: [
        {
          albumInfo: {
            title: "熊出没",
            pageUrl: "https://www.iqiyi.com/v_19rrll0l7g.html",
            channel: "少儿综艺,15",
            year: { key: "年份", value: "2012" },
            img: "https://img.example/a.jpg",
            introduction: "简介",
            videos: [
              { number: "1", subtitle: "上", pageUrl: "https://www.iqiyi.com/v_19rrll0l7g.html" },
              { number: "2", subtitle: "下", pageUrl: "https://www.iqiyi.com/v_second.html" },
            ],
          },
        },
        {
          albumInfo: {
            title: "短视频",
            pageUrl: "https://www.iqiyi.com/v_short.html?playertype=immersiveShort",
            playMode: 1,
          },
        },
      ],
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].pageUrl, "https://www.iqiyi.com/v_19rrll0l7g.html");
  assert.equal(items[0].title, "熊出没");
  assert.equal(items[0].remarks, "少儿综艺 · 2012");
  assert.deepEqual(items[0].episodes, [
    { name: "第1集 上", pageUrl: "https://www.iqiyi.com/v_19rrll0l7g.html" },
    { name: "第2集 下", pageUrl: "https://www.iqiyi.com/v_second.html" },
  ]);
});

test("iqiyiTvId decodes a watch page into the video id", () => {
  assert.equal(iqiyiTvId("https://www.iqiyi.com/v_24lp7m0j5ds.html"), "7836057357454700");
});

test("mapIqiyiAvlist reads the season episode pages", () => {
  const episodes = mapIqiyiAvlist({
    data: {
      epsodelist: [
        { order: 1, subtitle: "上", playUrl: "http://www.iqiyi.com/v_24lp7m0j5ds.html" },
        { order: 2, subtitle: "下", playUrl: "http://www.iqiyi.com/v_9qrk9bwtgw.html" },
      ],
    },
  });
  assert.deepEqual(episodes, [
    { name: "第1集 上", pageUrl: "https://www.iqiyi.com/v_24lp7m0j5ds.html" },
    { name: "第2集 下", pageUrl: "https://www.iqiyi.com/v_9qrk9bwtgw.html" },
  ]);
});

test("mapQqSearch keeps native cover pages", () => {
  const items = mapQqSearch({
    data: {
      normalList: {
        itemList: [
          {
            videoInfo: {
              title: "<em>繁花</em>",
              year: 2023,
              typeName: "电视剧",
              descrip: "沪上",
              playSites: [
                {
                  episodeInfoList: [
                    { url: "https://v.qq.com/x/cover/mzc00200whsp9r6/a0047l69jnp.html" },
                  ],
                },
              ],
            },
          },
          {
            videoInfo: {
              title: "外站",
              playSites: [
                {
                  episodeInfoList: [
                    { url: "https://v.qq.com/search_redirect.html?url=https%3A%2F%2Fwww.iqiyi.com%2Fv_1.html" },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "繁花");
  assert.equal(items[0].pageUrl, "https://v.qq.com/x/cover/mzc00200whsp9r6/a0047l69jnp.html");
});

test("mapQqEpisodeIds builds one page per tencent video id", () => {
  assert.equal(qqCoverId("https://v.qq.com/x/cover/mzc00200whsp9r6/a0047l69jnp.html"), "mzc00200whsp9r6");
  assert.deepEqual(mapQqEpisodeIds("mzc00200whsp9r6", ["a0047l69jnp", "g0047vju30g"]), [
    { name: "第1集", pageUrl: "https://v.qq.com/x/cover/mzc00200whsp9r6/a0047l69jnp.html" },
    { name: "第2集", pageUrl: "https://v.qq.com/x/cover/mzc00200whsp9r6/g0047vju30g.html" },
  ]);
});

test("mapYoukuEpisodes and show id come from the show page payload", () => {
  assert.equal(youkuShowId('{"showId":"cead24c56d054e5ca0b8"}'), "cead24c56d054e5ca0b8");
  assert.equal(
    mapYoukuEpisodes({
      videos: [{ seq: "1", title: "消失的记忆（上）", link: "http://v.youku.com/v_show/id_abc.html" }],
    })[0].pageUrl,
    "https://v.youku.com/v_show/id_abc.html",
  );
});

test("mapMgtvEpisodes reads the season pages", () => {
  assert.equal(mgtvVideoId("https://www.mgtv.com/b/510924/18126859.html"), "18126859");
  assert.deepEqual(
    mapMgtvEpisodes({
      data: {
        list: [
          { t1: "1", t4: "第1集", url: "/b/510924/18030368.html" },
          { t1: "彩蛋1", t4: "第1集", url: "/b/824230/24416235.html" },
        ],
      },
    }),
    [
      { name: "第1集", pageUrl: "https://www.mgtv.com/b/510924/18030368.html" },
      { name: "彩蛋1", pageUrl: "https://www.mgtv.com/b/824230/24416235.html" },
    ],
  );
});

test("mapBilibiliSeason reads episode pages", () => {
  const episodes = mapBilibiliSeason({
    result: { episodes: [{ title: "1", long_title: "新邻居", link: "https://www.bilibili.com/bangumi/play/ep810152" }] },
  });
  assert.equal(episodes[0].name, "第1集 新邻居");
  assert.equal(episodes[0].pageUrl, "https://www.bilibili.com/bangumi/play/ep810152");
});

test("mapYoukuSearch reads show cards", () => {
  const items = mapYoukuSearch({
    pageComponentList: [
      {
        data: {
          tempTitle: "熊出没之神奇宝物 第二季",
          feature: "2026 · 少儿",
          thumbUrl: "https://m.ykimg.com/cover.jpg",
          sourceName: "优酷",
          action: { value: "https://v.youku.com/v_show/id_abc.html" },
        },
      },
    ],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].pageUrl, "https://v.youku.com/v_show/id_abc.html");
});

test("mapBilibiliSearch reads bangumi pages", () => {
  const items = mapBilibiliSearch({
    code: 0,
    data: {
      result: [
        { title: "<em class=\"keyword\">熊出没</em>", url: "https://www.bilibili.com/bangumi/play/ss47144" },
      ],
    },
  });
  assert.equal(items[0].title, "熊出没");
  assert.match(items[0].pageUrl, /ss47144$/);
});

test("mapMgtvSearch hides a forbidden empty response", () => {
  assert.deepEqual(mapMgtvSearch({ code: 200, data: { forbidden: 1, listItems: [], contents: [] } }), []);
});

test("mapMgtvPage reads show cards and keeps one page per title", () => {
  const html = `
    <div class="m-search-serial">
      <a href="//www.mgtv.com/b/510924/18126859.html?fpa=se" title="去有风的地方">
        <img src="https://4img.hitv.com/a.jpg" alt="去有风的地方">
      </a>
      <span class="year">2023</span>
      <a class="hover-item" href="//www.mgtv.com/lib/2">电视剧</a>
      <a href="//www.mgtv.com/b/510924/18030368.html">1</a>
    </div>
    <div class="m-search-serial">
      <a href="//www.mgtv.com/b/512453/18036775.html" title="去有风的地方 卫视版">
        <img src="https://4img.hitv.com/b.jpg" alt="去有风的地方 卫视版">
      </a>
    </div>
  `;
  const items = mapMgtvPage(html);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "去有风的地方");
  assert.equal(items[0].pageUrl, "https://www.mgtv.com/b/510924/18126859.html");
  assert.equal(items[0].remarks, "电视剧 · 2023");
  assert.equal(items[1].pageUrl, "https://www.mgtv.com/b/512453/18036775.html");
});

test("searchSites files a Mango page found by iQiyi under the Mango tab", async () => {
  const sites = await searchSites("去有风的地方", {
    fetchTextFn: async () => "",
    renderPage: async () => "",
    fetchJsonFn: async (url) => {
      if (String(url).includes("iqiyi.com")) {
        return {
          data: {
            templates: [
              { albumInfo: { title: "去有风的地方", pageUrl: "https://www.mgtv.com/h/512453.html" } },
            ],
          },
        };
      }
      return { data: { forbidden: 1, listItems: [] } };
    },
  });
  assert.deepEqual(sites.map((site) => site.id), ["mgtv"]);
  assert.equal(sites[0].items[0].pageUrl, "https://www.mgtv.com/h/512453.html");
});

test("searchSites omits sites that return nothing", async () => {
  const sites = await searchSites("熊出没", {
    fetchTextFn: async () => "",
    renderPage: async () => "",
    fetchJsonFn: async (url) => {
      if (String(url).includes("iqiyi.com")) {
        return {
          data: {
            templates: [
              { albumInfo: { title: "熊出没", pageUrl: "https://www.iqiyi.com/v_19rrll0l7g.html" } },
            ],
          },
        };
      }
      if (String(url).includes("mgtv.com")) {
        return { data: { forbidden: 1, listItems: [] } };
      }
      throw new Error("down");
    },
  });
  assert.deepEqual(sites.map((site) => site.id), ["qiyi"]);
  assert.equal(sites[0].items[0].pageUrl, "https://www.iqiyi.com/v_19rrll0l7g.html");
});
