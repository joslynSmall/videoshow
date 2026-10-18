import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDmkuResponse } from "../src/danmaku.js";
import { splitDanmakuText } from "../public/danmaku-text.js";

test("normalizeDmkuResponse filters dirty items and maps modes", () => {
  const result = normalizeDmkuResponse({
    code: 23,
    danmuku: [
      [2, "right", "#ffffff", "", ""],
      [],
      [5, "top", "#FF0000", "", "顶部弹幕"],
      ["bad", "right", "#fff", "", "invalid time"],
      [1, "right", "#fff", "", "   "],
      [3, "bottom", "#00ff00", "", "底部弹幕"],
      [1, "right", "not-a-color", "", "普通弹幕"],
    ],
  });

  assert.equal(result.provider, "dmku");
  assert.equal(result.count, 3);
  assert.deepEqual(
    result.items.map((item) => item.text),
    ["普通弹幕", "底部弹幕", "顶部弹幕"],
  );
  assert.equal(result.items[0].mode, 0);
  assert.equal(result.items[0].color, "#FFFFFF");
  assert.equal(result.items[1].mode, 2);
  assert.equal(result.items[2].mode, 1);
  assert.equal(result.items[2].color, "#FF0000");
});

test("splitDanmakuText turns image markup into image parts", () => {
  const parts = splitDanmakuText(
    '好图<img src="https://img.example/a.png" width="20">[img]https://img.example/b.webp[/img]',
  );
  assert.deepEqual(parts, [
    { type: "text", value: "好图" },
    { type: "image", src: "https://img.example/a.png" },
    { type: "image", src: "https://img.example/b.webp" },
  ]);
});

test("splitDanmakuText drops non-https image sources", () => {
  const parts = splitDanmakuText(
    '<img src="javascript:alert(1)"><img src="http://img.example/a.png">普通',
  );
  assert.deepEqual(parts, [{ type: "text", value: "普通" }]);
});

test("normalizeDmkuResponse returns an empty collection for no data", () => {
  assert.deepEqual(normalizeDmkuResponse({}), {
    provider: "dmku",
    count: 0,
    items: [],
  });
});
