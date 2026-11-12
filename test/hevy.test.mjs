// Unit tests for the Hevy client's exercise search: no network, no key, no
// wrangler. Hevy is a fake `fetch` serving a made-up library; the per-user
// cache is a Map. Run with `npm run test:unit` (Node 22.18 or newer, which
// imports the TypeScript source directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { HevyClient } from "../src/hevy.ts";

/** A fake Hevy holding `count` templates; records each page it was asked for. */
function fakeHevy(count) {
  const library = Array.from({ length: count }, (_, i) => ({
    id: `T${String(i + 1).padStart(4, "0")}`,
    title: i === count - 1 ? "Walking Lunge" : `Exercise ${i + 1}`,
  }));
  const pagesAsked = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    assert.equal(u.pathname, "/v1/exercise_templates");
    const page = Number(u.searchParams.get("page"));
    const pageSize = Number(u.searchParams.get("pageSize"));
    pagesAsked.push(page);
    const body = {
      page,
      page_count: Math.ceil(library.length / pageSize),
      exercise_templates: library.slice((page - 1) * pageSize, page * pageSize),
    };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { library, pagesAsked, fetchImpl };
}

function fakeCache() {
  const store = new Map();
  return {
    store,
    cache: {
      key: "tplcache:test-user",
      ttlSeconds: 60,
      kv: {
        get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
        put: async (key, value) => void store.set(key, value),
        delete: async (key) => void store.delete(key),
      },
    },
  };
}

async function withFetch(fetchImpl, run) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("a library past 600 templates is searched whole", async () => {
  const hevy = fakeHevy(860);
  await withFetch(hevy.fetchImpl, async () => {
    const found = await new HevyClient("key").searchExerciseTemplates({ query: "walking lunge" });
    // The match is template 860 of 860: the old six-page stop never saw it.
    assert.equal(found.total, 1);
    assert.equal(found.exercise_templates[0].id, "T0860");
    assert.equal(found.note, undefined);
    assert.deepEqual(hevy.pagesAsked, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

test("paging walks every template once, and says how many pages there are", async () => {
  const hevy = fakeHevy(860);
  const { cache } = fakeCache();
  await withFetch(hevy.fetchImpl, async () => {
    const seen = [];
    let page = 1;
    let pageCount = 1;
    do {
      const got = await new HevyClient("key", cache).searchExerciseTemplates({ limit: 100, page });
      assert.equal(got.page, page);
      assert.equal(got.total, 860);
      pageCount = got.page_count;
      seen.push(...got.exercise_templates.map((t) => t.id));
      page++;
    } while (page <= pageCount);
    assert.equal(pageCount, 9);
    assert.deepEqual(seen, hevy.library.map((t) => t.id));
    // Nine tool calls, one read of Hevy: the rest came from the cache.
    assert.deepEqual(hevy.pagesAsked, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

test("the default is the first 20, and a page past the end is empty, not an error", async () => {
  const hevy = fakeHevy(45);
  await withFetch(hevy.fetchImpl, async () => {
    const first = await new HevyClient("key").searchExerciseTemplates({ query: "exercise" });
    assert.equal(first.exercise_templates.length, 20);
    assert.deepEqual([first.page, first.page_count, first.total], [1, 3, 44]);
    const past = await new HevyClient("key").searchExerciseTemplates({ query: "exercise", page: 4 });
    assert.deepEqual(past.exercise_templates, []);
    const none = await new HevyClient("key").searchExerciseTemplates({ query: "no such thing" });
    assert.deepEqual([none.page_count, none.total, none.exercise_templates.length], [1, 0, 0]);
  });
});

test("a cached list from before this change (a bare array, maybe cut at 600) is read again", async () => {
  const hevy = fakeHevy(860);
  const { cache, store } = fakeCache();
  store.set(cache.key, JSON.stringify(hevy.library.slice(0, 600)));
  await withFetch(hevy.fetchImpl, async () => {
    const found = await new HevyClient("key", cache).searchExerciseTemplates({ query: "walking lunge" });
    assert.equal(found.total, 1);
    assert.equal(hevy.pagesAsked.length, 9);
    assert.equal(JSON.parse(store.get(cache.key)).templates.length, 860);
  });
});

test("a library too big to read whole says so instead of looking complete", async () => {
  const hevy = fakeHevy(2100);
  const { cache } = fakeCache();
  await withFetch(hevy.fetchImpl, async () => {
    const found = await new HevyClient("key", cache).searchExerciseTemplates({ query: "walking lunge" });
    assert.equal(found.total, 0);
    assert.match(found.note, /only the first 2000 were searched/);
    assert.equal(hevy.pagesAsked.length, 20);
    // The warning survives the cache.
    const again = await new HevyClient("key", cache).searchExerciseTemplates({ query: "walking lunge" });
    assert.match(again.note, /only the first 2000 were searched/);
    assert.equal(hevy.pagesAsked.length, 20);
  });
});
