const lazyModule = await import("some-package");

export const lazyResult = lazyModule.doSomething();
