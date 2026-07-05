import {
  Terminal, FileText, Pencil, FileEdit, FolderSearch, Search, Globe,
  Bot, ClipboardList, BookOpen, Settings, Hand,
  type LucideIcon,
} from "lucide-react";

export interface ToolConfig {
  Icon: LucideIcon;
  color: string;
  bg: string;
  border: string;
  family: "file" | "shell" | "mcp" | "ask_human" | "web" | "agent" | "other";
  glow?: boolean;
}

const CONFIGS: Record<string, ToolConfig> = {
  Read:         { Icon: FileText,      color: "text-sky-300",     bg: "bg-sky-900/40",     border: "border-sky-700/50",     family: "file" },
  Write:        { Icon: FileEdit,      color: "text-sky-300",     bg: "bg-sky-900/40",     border: "border-sky-700/50",     family: "file" },
  Edit:         { Icon: Pencil,        color: "text-sky-300",     bg: "bg-sky-900/40",     border: "border-sky-700/50",     family: "file" },
  MultiEdit:    { Icon: Pencil,        color: "text-sky-300",     bg: "bg-sky-900/40",     border: "border-sky-700/50",     family: "file" },
  Glob:         { Icon: FolderSearch,  color: "text-sky-300",     bg: "bg-sky-900/40",     border: "border-sky-700/50",     family: "file" },
  Grep:         { Icon: Search,        color: "text-sky-300",     bg: "bg-sky-900/40",     border: "border-sky-700/50",     family: "file" },
  Bash:         { Icon: Terminal,      color: "text-amber-300",   bg: "bg-amber-900/40",   border: "border-amber-700/50",   family: "shell" },
  WebFetch:     { Icon: Globe,         color: "text-emerald-300", bg: "bg-emerald-900/40", border: "border-emerald-700/50", family: "web" },
  WebSearch:    { Icon: Globe,         color: "text-emerald-300", bg: "bg-emerald-900/40", border: "border-emerald-700/50", family: "web" },
  Task:         { Icon: Bot,           color: "text-indigo-300",  bg: "bg-indigo-900/40",  border: "border-indigo-700/50",  family: "agent" },
  TodoWrite:    { Icon: ClipboardList, color: "text-indigo-300",  bg: "bg-indigo-900/40",  border: "border-indigo-700/50",  family: "agent" },
  NotebookEdit: { Icon: BookOpen,      color: "text-indigo-300",  bg: "bg-indigo-900/40",  border: "border-indigo-700/50",  family: "agent" },
  ask_human:    { Icon: Hand,          color: "text-pink-300",    bg: "bg-pink-900/40",    border: "border-pink-700/50",    family: "ask_human", glow: true },
};

const DEFAULT_CONFIG: ToolConfig = {
  Icon: Settings,
  color: "text-slate-300",
  bg: "bg-slate-800/50",
  border: "border-slate-700/50",
  family: "other",
};

const MCP_CONFIG: ToolConfig = {
  Icon: Settings,
  color: "text-purple-300",
  bg: "bg-purple-900/40",
  border: "border-purple-700/50",
  family: "mcp",
};

export function getToolConfig(name: string): ToolConfig {
  if (name === "ask_human" || name.endsWith("__ask_human")) {
    return CONFIGS["ask_human"]!;
  }
  if (name.startsWith("mcp__")) {
    const bare = name.split("__").pop() ?? name;
    return CONFIGS[bare] ?? MCP_CONFIG;
  }
  return CONFIGS[name] ?? DEFAULT_CONFIG;
}
