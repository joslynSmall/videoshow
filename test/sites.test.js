import assert from "node:assert/strict";
import test from "node:test";
import { mapBilibiliSearch } from "../src/sites/impl/bilibili.js";
import { iqiyiTvId, mapIqiyiAvlist, mapIqiyiSearch } from "../src/sites/impl/iqiyi.js";
import { mapMgtvPage, mapMgtvSearch } from "../src/sites/impl/mgtv.js";
import { loadQqEpisodes, mapQqEpisodes, mapQqSearch, qqCoverId } from "../src/sites/impl/qq.js";
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
              { number: "花絮1", subtitle: "花絮1", pageUrl: "https://www.iqiyi.com/v_extra1.html" },
              { number: "专访", subtitle: "专访", pageUrl: "https://www.iqiyi.com/v_extra2.html" },
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

test("mapQqEpisodes keeps only numbered episodes and drops trailers and extras", () => {
  assert.equal(qqCoverId("https://v.qq.com/x/cover/mzc00200whsp9r6/a0047l69jnp.html"), "mzc00200whsp9r6");
  const rows = [
    { vid: "t0", title: "《庆余年第三季》首发概念海报", is_trailer: "0" },
    { vid: "a0047l69jnp", title: "1" },
    { vid: "g0047vju30g", title: "2" },
    { vid: "g0047vju30g", title: "2" },
    { vid: "x1", title: "彩蛋1" },
    { vid: "x2", title: "番外" },
    { title: "第二季" },
  ];
  assert.deepEqual(mapQqEpisodes("mzc00200whsp9r6", rows), [
    { name: "第1集", pageUrl: "https://v.qq.com/x/cover/mzc00200whsp9r6/a0047l69jnp.html" },
    { name: "第2集", pageUrl: "https://v.qq.com/x/cover/mzc00200whsp9r6/g0047vju30g.html" },
  ]);
  assert.deepEqual(mapQqEpisodes("mzc00200whsp9r6", [{ vid: "t0", title: "首发概念海报" }]), []);
});

test("loadQqEpisodes merges every tab of the episode list", async () => {
  const page = (rows, tabs = []) => ({
    data: {
      module_list_datas: [
        {
          module_datas: [
            {
              module_params: { desk_module_type: "episode_list", tabs: JSON.stringify(tabs) },
              item_data_lists: { item_datas: rows.map((item_params) => ({ item_params })) },
            },
          ],
        },
      ],
    },
  });
  const bodies = [];
  const episodes = await loadQqEpisodes("https://v.qq.com/x/cover/cid1/v1.html", {
    fetchJsonFn: async (_url, init) => {
      const params = JSON.parse(init.body).page_params;
      bodies.push(params.page_context);
      if (params.page_context === "tab2") {
        return page([{ vid: "v31", title: "31" }, { vid: "e1", title: "彩蛋1" }]);
      }
      return page(
        [{ vid: "v1", title: "1" }, { vid: "v30", title: "30" }],
        [
          { selected: true, page_context: "tab1" },
          { selected: false, page_context: "tab2" },
        ],
      );
    },
  });
  assert.deepEqual(
    episodes.map((item) => item.name),
    ["第1集", "第30集", "第31集"],
  );
  assert.equal(bodies.length, 2);
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

test("mapMgtvEpisodes keeps only full episodes and drops previews and extras", () => {
  assert.equal(mgtvVideoId("https://www.mgtv.com/b/510924/18126859.html"), "18126859");
  assert.deepEqual(
    mapMgtvEpisodes({
      data: {
        list: [
          { t1: "1", t4: "第1集", isIntact: "1", url: "/b/510924/18030368.html" },
          { t1: "2", t4: "第2集", isIntact: "3", url: "/b/510924/preview2.html" },
          { t1: "2", t4: "第2集", isIntact: "1", url: "/b/510924/18030369.html" },
          { t1: "番外", t4: "第1集", isIntact: "5", url: "/b/510924/extra.html" },
          { t1: "彩蛋1", t4: "第1集", isIntact: "7", url: "/b/824230/24416235.html" },
          { t1: "彩蛋2", t4: "第2集", url: "/b/824230/no-flag.html" },
        ],
      },
    }),
    [
      { name: "第1集", pageUrl: "https://www.mgtv.com/b/510924/18030368.html" },
      { name: "第2集", pageUrl: "https://www.mgtv.com/b/510924/18030369.html" },
    ],
  );
});

test("mapBilibiliSeason reads episode pages and drops previews", () => {
  const episodes = mapBilibiliSeason({
    result: {
      episodes: [
        { title: "1", long_title: "新邻居", section_type: 0, link: "https://www.bilibili.com/bangumi/play/ep810152" },
        { title: "2", badge: "预告", section_type: 1, link: "https://www.bilibili.com/bangumi/play/ep810153" },
        { title: "3", badge: "预告", link: "https://www.bilibili.com/bangumi/play/ep810154" },
        { title: "2", badge: "会员", section_type: 0, link: "https://www.bilibili.com/bangumi/play/ep810155" },
      ],
    },
  });
  assert.deepEqual(episodes, [
    { name: "第1集 新邻居", pageUrl: "https://www.bilibili.com/bangumi/play/ep810152" },
    { name: "第2集", pageUrl: "https://www.bilibili.com/bangumi/play/ep810155" },
  ]);
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
