import { createContext } from "react-router";

import type { AppRuntime } from "#src/platform/runtime.server";

export const appRuntimeContext = createContext<AppRuntime>();
