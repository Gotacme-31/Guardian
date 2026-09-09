import { describe, expect, it } from "vitest";

import {
  classifyUpgradeType,
  createDependencyTargetResolver,
  type DependencyContext,
  type DependencyResolutionKind,
  type DependencyTargetResolution,
} from "../src/index.js";

const metadata = {
  "dist-tags": {
    latest: "2.1.0",
    next: "3.0.0-beta.1",
    beta: "2.2.0-beta.1",
  },
  versions: {
    "1.7.9": {},
    "1.7.10": {},
    "1.8.0": {},
    "1.9.0-beta.1": {},
    "2.0.0-beta.1": {},
    "2.0.0": {},
    "2.1.0": {},
    "2.2.0-beta.1": {},
    "3.0.0-beta.1": {},
  },
};

function dependencyContext(options: {
  dependency?: string;
  kind?: DependencyResolutionKind;
  installedVersion?: string | null;
} = {}): DependencyContext {
  const dependency = options.dependency ?? "axios";
  const kind = options.kind ?? "registry";
  const installedVersion = options.installedVersion === undefined ? "1.7.9" : options.installedVersion;
  return {
    dependency,
    declaration: {
      type: "dependency",
      declaredVersion: kind === "workspace" ? "workspace:*" : "^1.7.0",
    },
    resolution: {
      dependency,
      dependencyType: "dependency",
      declaredVersion: kind === "workspace" ? "workspace:*" : "^1.7.0",
      ...(installedVersion === null ? {} : { resolvedVersion: installedVersion }),
      kind,
      status: "resolved",
    },
    usage: {
      used: false,
      files: [],
      imports: [],
      importedSymbols: [],
      apiUsages: [],
    },
  };
}

function jsonFetch(
  body: unknown,
  status = 200,
  onRequest?: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => void,
): typeof fetch {
  return async (input, init) => {
    onRequest?.(input, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function resolvedVersion(result: DependencyTargetResolution): string | undefined {
  return result.status === "resolved" ? result.resolvedVersion : undefined;
}

function upgradeType(result: DependencyTargetResolution): string | undefined {
  return result.status === "resolved" ? result.upgradeType : undefined;
}

describe("target version resolution", () => {
  it("resolves latest from the npm dist-tag", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      requestedTarget: "latest",
      resolvedVersion: "2.1.0",
      distTag: "latest",
      status: "resolved",
      source: "npm",
      upgradeType: "major",
    });
  });

  it("resolves an existing exact version", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    await expect(resolver.resolve(dependencyContext(), "2.0.0")).resolves.toMatchObject({
      resolvedVersion: "2.0.0",
      status: "resolved",
    });
  });

  it("does not resolve an unpublished exact version", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    await expect(resolver.resolve(dependencyContext(), "2.0.1")).resolves.toMatchObject({
      status: "not-found",
      issue: "version-not-found",
    });
  });

  it("encodes scoped package names and sends the Guardian user agent", async () => {
    let requestedUrl = "";
    let userAgent: string | null = null;
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch(metadata, 200, (input, init) => {
        requestedUrl = String(input);
        userAgent = new Headers(init?.headers).get("User-Agent");
      }),
    });

    const result = await resolver.resolve(
      dependencyContext({ dependency: "@prisma/client" }),
      "latest",
    );

    expect(result.status).toBe("resolved");
    expect(new URL(requestedUrl).pathname).toBe("/%40prisma%2Fclient");
    expect(userAgent).toBe("Guardian/0.0.1");
  });

  it("resolves the next dist-tag including its prerelease", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    await expect(resolver.resolve(dependencyContext(), "next")).resolves.toMatchObject({
      resolvedVersion: "3.0.0-beta.1",
      distTag: "next",
      status: "resolved",
    });
  });

  it("returns not-found for a missing dist-tag", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    await expect(resolver.resolve(dependencyContext(), "canary")).resolves.toMatchObject({
      status: "not-found",
      issue: "tag-not-found",
    });
  });

  it("supports npm dist-tags that do not start with a letter", async () => {
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch({
        "dist-tags": { _legacy: "1.7.9" },
        versions: { "1.7.9": {} },
      }),
    });

    await expect(resolver.resolve(dependencyContext(), "_legacy")).resolves.toMatchObject({
      status: "resolved",
      resolvedVersion: "1.7.9",
      distTag: "_legacy",
    });
  });

  it("resolves a caret range", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    expect(resolvedVersion(await resolver.resolve(dependencyContext(), "^1.7.0"))).toBe("1.8.0");
  });

  it("resolves a tilde range", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    expect(resolvedVersion(await resolver.resolve(dependencyContext(), "~1.7.0"))).toBe("1.7.10");
  });

  it("resolves a compound range", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    expect(resolvedVersion(await resolver.resolve(dependencyContext(), ">=1.7 <2"))).toBe("1.8.0");
  });

  it("selects the highest published version satisfying a range", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    expect(resolvedVersion(await resolver.resolve(dependencyContext(), "^2.0.0"))).toBe("2.1.0");
  });

  it("returns not-found when no published version satisfies a range", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    await expect(resolver.resolve(dependencyContext(), "^9.0.0")).resolves.toMatchObject({
      status: "not-found",
      issue: "no-matching-version",
    });
  });

  it("resolves an explicitly requested prerelease", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    await expect(resolver.resolve(dependencyContext(), "2.0.0-beta.1")).resolves.toMatchObject({
      resolvedVersion: "2.0.0-beta.1",
      status: "resolved",
    });
  });

  it("does not select prereleases for an ordinary range", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    expect(resolvedVersion(await resolver.resolve(
      dependencyContext(),
      ">=1.0.0 <3.0.0",
    ))).toBe("2.1.0");
  });

  it("classifies the same installed and target version", () => {
    expect(classifyUpgradeType("1.7.9", "1.7.9")).toBe("same");
  });

  it("classifies a patch upgrade", () => {
    expect(classifyUpgradeType("1.7.9", "1.7.10")).toBe("patch");
  });

  it("classifies a minor upgrade", () => {
    expect(classifyUpgradeType("1.7.9", "1.8.0")).toBe("minor");
  });

  it("classifies a major upgrade", () => {
    expect(classifyUpgradeType("1.7.9", "2.0.0")).toBe("major");
  });

  it("classifies a downgrade", () => {
    expect(classifyUpgradeType("2.0.0", "1.9.0")).toBe("downgrade");
  });

  it.each([
    ["2.0.0-beta.1", "2.0.0", "prerelease"],
    ["2.0.0-beta.1", "2.0.0-beta.2", "prerelease"],
    ["2.0.0-rc.1", "2.0.0", "prerelease"],
    ["1.9.0", "2.0.0-beta.1", "major"],
    ["2.0.0", "2.0.0-beta.1", "downgrade"],
  ] as const)("classifies %s to %s as %s", (installed, target, expected) => {
    expect(classifyUpgradeType(installed, target)).toBe(expected);
  });

  it("returns unknown upgrade type when installed version is unavailable", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });
    const result = await resolver.resolve(dependencyContext({ installedVersion: null }), "latest");

    expect(result.installedVersion).toBeUndefined();
    expect(upgradeType(result)).toBe("unknown");
  });

  it("returns unsupported for a workspace dependency without fetching", async () => {
    let fetchCount = 0;
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch(metadata, 200, () => {
        fetchCount += 1;
      }),
    });

    await expect(resolver.resolve(
      dependencyContext({ kind: "workspace" }),
      "latest",
    )).resolves.toMatchObject({
      status: "unsupported",
      issue: "non-registry-dependency",
    });
    expect(fetchCount).toBe(0);
  });

  it("returns unsupported for a link dependency", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    expect((await resolver.resolve(
      dependencyContext({ kind: "link" }),
      "latest",
    )).status).toBe("unsupported");
  });

  it("normalizes a malformed registry document", async () => {
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch({ versions: { "1.0.0": {} } }),
    });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "invalid-registry-response",
    });
  });

  it("normalizes invalid registry JSON", async () => {
    const invalidJsonFetch: typeof fetch = async () => new Response("not-json", { status: 200 });
    const resolver = createDependencyTargetResolver({ fetch: invalidJsonFetch });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "invalid-registry-response",
    });
  });

  it("distinguishes an npm package 404", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch({}, 404) });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "not-found",
      issue: "package-not-found",
      httpStatus: 404,
    });
  });

  it("normalizes network failures", async () => {
    const failingFetch: typeof fetch = async () => {
      throw new Error("network unavailable");
    };
    const resolver = createDependencyTargetResolver({ fetch: failingFetch });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "network-error",
    });
  });

  it("aborts and normalizes requests that exceed the timeout", async () => {
    const hangingFetch: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
    const resolver = createDependencyTargetResolver({ fetch: hangingFetch, timeoutMs: 5 });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "timeout",
    });
  });

  it("enforces timeout when an injected fetch ignores AbortSignal", async () => {
    const nonCooperativeFetch: typeof fetch = () => new Promise(() => undefined);
    const resolver = createDependencyTargetResolver({
      fetch: nonCooperativeFetch,
      timeoutMs: 5,
    });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "timeout",
    });
  });

  it("rejects invalid timeout configuration", () => {
    expect(() => createDependencyTargetResolver({
      fetch: jsonFetch(metadata),
      timeoutMs: 0,
    })).toThrow("timeoutMs must be a positive finite number");
  });

  it("normalizes npm HTTP 429 responses", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch({}, 429) });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "rate-limited",
      httpStatus: 429,
    });
  });

  it("normalizes npm HTTP 500 responses", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch({}, 500) });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "registry-unavailable",
      httpStatus: 500,
    });
  });

  it("caches metadata requests by package name", async () => {
    let fetchCount = 0;
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch(metadata, 200, () => {
        fetchCount += 1;
      }),
    });

    await resolver.resolve(dependencyContext(), "latest");
    await resolver.resolve(dependencyContext(), "^2.0.0");

    expect(fetchCount).toBe(1);
  });

  it("deduplicates concurrent metadata requests", async () => {
    let fetchCount = 0;
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch(metadata, 200, () => {
        fetchCount += 1;
      }),
    });

    await Promise.all([
      resolver.resolve(dependencyContext(), "latest"),
      resolver.resolve(dependencyContext(), "next"),
    ]);

    expect(fetchCount).toBe(1);
  });

  it("does not retain transient registry failures in cache", async () => {
    let fetchCount = 0;
    const retryingFetch: typeof fetch = async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? new Response("unavailable", { status: 500 })
        : new Response(JSON.stringify(metadata), { status: 200 });
    };
    const resolver = createDependencyTargetResolver({ fetch: retryingFetch });

    expect((await resolver.resolve(dependencyContext(), "latest")).status)
      .toBe("registry-error");
    expect((await resolver.resolve(dependencyContext(), "latest")).status)
      .toBe("resolved");
    expect(fetchCount).toBe(2);
  });

  it("returns deterministic results for identical metadata", async () => {
    const firstResolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });
    const secondResolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    expect(await firstResolver.resolve(dependencyContext(), "^2.0.0"))
      .toEqual(await secondResolver.resolve(dependencyContext(), "^2.0.0"));
  });

  it("does not mutate the dependency context", async () => {
    const context = dependencyContext();
    const original = structuredClone(context);
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    await resolver.resolve(context, "latest");

    expect(context).toEqual(original);
  });

  it("rejects an empty target without fetching", async () => {
    let fetchCount = 0;
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch(metadata, 200, () => {
        fetchCount += 1;
      }),
    });

    await expect(resolver.resolve(dependencyContext(), "")).resolves.toMatchObject({
      status: "invalid-request",
      issue: "invalid-target",
    });
    expect(fetchCount).toBe(0);
  });

  it("rejects a malformed target request", async () => {
    let fetchCount = 0;
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch(metadata, 200, () => {
        fetchCount += 1;
      }),
    });

    await expect(resolver.resolve(dependencyContext(), "^not-a-version")).resolves.toMatchObject({
      status: "invalid-request",
      issue: "invalid-target",
    });
    expect(fetchCount).toBe(0);
  });

  it("rejects unsafe package names before fetching", async () => {
    let fetchCount = 0;
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch(metadata, 200, () => {
        fetchCount += 1;
      }),
    });

    await expect(resolver.resolve(
      dependencyContext({ dependency: ".." }),
      "latest",
    )).resolves.toMatchObject({
      status: "invalid-request",
      issue: "invalid-package-name",
    });
    expect(fetchCount).toBe(0);
  });

  it("does not confuse inherited object names with dist-tags", async () => {
    const resolver = createDependencyTargetResolver({ fetch: jsonFetch(metadata) });

    await expect(resolver.resolve(dependencyContext(), "constructor")).resolves.toMatchObject({
      status: "not-found",
      issue: "tag-not-found",
    });
  });

  it("rejects a dist-tag pointing to absent version metadata", async () => {
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch({
        "dist-tags": { latest: "9.0.0" },
        versions: { "1.0.0": {} },
      }),
    });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "invalid-registry-response",
    });
  });

  it("rejects malformed unused registry metadata", async () => {
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch({
        "dist-tags": { latest: "1.0.0", broken: "9.0.0" },
        versions: { "1.0.0": {} },
      }),
    });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "invalid-registry-response",
    });
  });

  it("rejects invalid dist-tag names in registry metadata", async () => {
    const resolver = createDependencyTargetResolver({
      fetch: jsonFetch({
        "dist-tags": { latest: "1.0.0", "bad/tag": "1.0.0" },
        versions: { "1.0.0": {} },
      }),
    });

    await expect(resolver.resolve(dependencyContext(), "latest")).resolves.toMatchObject({
      status: "registry-error",
      issue: "invalid-registry-response",
    });
  });
});
