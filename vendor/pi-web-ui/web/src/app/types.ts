import type { useChat } from "../use-chat";

/** @COUPLED App.tsx, app-views.tsx: one connection and bridge for every view. */
export type AppConnection = ReturnType<typeof useChat>;
export type ViewName = "chat" | "terminal" | "git" | `plugin:${string}`;
