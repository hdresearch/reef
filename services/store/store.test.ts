import { afterAll, describe, expect, test } from "bun:test";
import { createTestHarness, type TestHarness } from "../../src/core/testing.js";
import vmTree from "../vm-tree/index.js";
import store from "./index.js";

let t: TestHarness;
const setup = (async () => {
  t = await createTestHarness({ services: [vmTree, store] });
})();
afterAll(() => {
  t?.cleanup();
});

const A = { auth: true };
const put = (_key: string, value: unknown) => ({ method: "PUT", body: { value }, auth: true });
const del = (_key: string) => ({ method: "DELETE", auth: true });

describe("store", () => {
  test("list keys — empty initially", async () => {
    await setup;
    const { status, data } = await t.json<any>("/store", A);
    expect(status).toBe(200);
    expect(data.keys).toEqual([]);
  });

  test("put and get a value", async () => {
    await setup;
    const { status: putStatus, data: putData } = await t.json<any>("/store/greeting", put("greeting", "hello world"));
    expect(putStatus).toBe(200);
    expect(putData.key).toBe("greeting");
    expect(putData.value).toBe("hello world");

    const { data: getData } = await t.json<any>("/store/greeting", A);
    expect(getData.value).toBe("hello world");
    expect(getData.createdAt).toBeNumber();
    expect(getData.updatedAt).toBeNumber();
  });

  test("put complex JSON value", async () => {
    await setup;
    const complex = { nested: { array: [1, 2, 3] }, flag: true };
    await t.json<any>("/store/complex", put("complex", complex));

    const { data } = await t.json<any>("/store/complex", A);
    expect(data.value).toEqual(complex);
  });

  test("update preserves createdAt", async () => {
    await setup;
    await t.json<any>("/store/mutable", put("mutable", "v1"));
    await t.json<any>("/store/mutable", put("mutable", "v2"));

    const { data } = await t.json<any>("/store/mutable", A);
    expect(data.value).toBe("v2");
  });

  test("get nonexistent key returns 404", async () => {
    await setup;
    const { status } = await t.json("/store/nope", A);
    expect(status).toBe(404);
  });

  test("delete a key", async () => {
    await setup;
    await t.json("/store/ephemeral", put("ephemeral", "temp"));

    const { status, data } = await t.json<any>("/store/ephemeral", del("ephemeral"));
    expect(status).toBe(200);
    expect(data.deleted).toBe("ephemeral");

    const { status: getStatus } = await t.json("/store/ephemeral", A);
    expect(getStatus).toBe(404);
  });

  test("delete nonexistent key returns 404", async () => {
    await setup;
    const { status } = await t.json("/store/ghost", del("ghost"));
    expect(status).toBe(404);
  });

  test("list keys shows all entries", async () => {
    await setup;
    await t.json("/store/a", put("a", 1));
    await t.json("/store/b", put("b", 2));

    const { data } = await t.json<any>("/store", A);
    const keys = data.keys.map((k: any) => k.key);
    expect(keys).toContain("a");
    expect(keys).toContain("b");
  });

  test("requires auth", async () => {
    await setup;
    const { status } = await t.json("/store");
    expect(status).toBe(401);
  });
});
