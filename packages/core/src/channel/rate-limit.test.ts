import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "./rate-limit";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createRateLimiter", () => {
  test("first call is not delayed", async () => {
    const limiter = createRateLimiter(200);
    const started = Date.now();

    await limiter.wait("628111");

    expect(Date.now() - started).toBeLessThan(50);
  });

  test("second call to the same phone is delayed", async () => {
    const limiter = createRateLimiter(200);

    await limiter.wait("628111");
    const started = Date.now();
    await limiter.wait("628111");

    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  test("different phones do not block each other", async () => {
    const limiter = createRateLimiter(200);

    await limiter.wait("628111");
    const started = Date.now();
    await limiter.wait("628222");

    expect(Date.now() - started).toBeLessThan(50);
  });

  test("serialises concurrent calls to the same phone", async () => {
    const limiter = createRateLimiter(150);
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2].map(async (index) => {
        await limiter.wait("628111");
        order.push(index);
      }),
    );

    expect(order).toEqual([0, 1, 2]);
  });

  test("delays rather than dropping sends", async () => {
    const limiter = createRateLimiter(120);
    const started = Date.now();

    await limiter.wait("628111");
    await limiter.wait("628111");

    // If the limiter dropped sends, the second call would return instantly.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("does not add delay after a long pause", async () => {
    const limiter = createRateLimiter(100);

    await limiter.wait("628111");
    await sleep(150);
    const started = Date.now();
    await limiter.wait("628111");

    expect(Date.now() - started).toBeLessThan(50);
  });
});
