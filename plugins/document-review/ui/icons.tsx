// Icons of «Documents»: one Lucide set bundled with the plugin, stroke 1.75 (--icon-stroke-width), sizes 14/16/20 set by
// the design-system classes (or explicitly). bb's experimental_Icon knows only a small set of names and draws a
// lightning bolt for the rest (seen in W-03), so the plugin does not depend on that registry.
import {
  Download, FileBraces, FileCog, FileKey, FileSliders, FileSpreadsheet, FileType, Settings, CodeXml, WrapText, ListOrdered, ChevronsDownUp, Copy, ShieldOff, Gauge, FileWarning, GitBranch, User, Users, Package, RotateCcw, ScanEye, Shield, HardDrive, MoveHorizontal, ClipboardCopy, MonitorSmartphone, Plus, FolderX, GitBranchPlus, GitBranchMinus, Archive, BellOff, ListChecks,
  ArrowUpDown, Bot, Check, CircleSlash, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, Circle, CircleDot, Diff, Ellipsis, Eye, EyeOff, File, Files, FileText, FileX,
  FileX2, Focus, Folder, FolderGit2, FolderOpen, GitMerge, Hand, History, Image, Inbox, Info, Keyboard, Link, ListFilter, ListTree, LoaderCircle, type LucideIcon, Maximize2,
  MessageSquare, MessageSquarePlus, MoveRight, PanelLeftClose, PanelLeftOpen, Play, RefreshCw, Reply, Search, Send, Square, SquareCheck, StickyNote,
  Trash2, TriangleAlert, UnfoldHorizontal, WifiOff, X, Workflow, Move, ZoomIn, ZoomOut, Scan, GitCompare, Lock, Minimize2, ImageOff, Languages,
} from "lucide-react";
import type { CSSProperties } from "react";

const ICONS: Record<string, LucideIcon> = {
  Download, FileBraces, FileCog, FileKey, FileSliders, FileSpreadsheet, FileType, Settings, CodeXml, WrapText, ListOrdered, ChevronsDownUp, Copy, ShieldOff, Gauge, FileWarning, GitBranch, User, Users, Package, RotateCcw, ScanEye, Shield, HardDrive, MoveHorizontal, ClipboardCopy, MonitorSmartphone, Plus, FolderX, GitBranchPlus, GitBranchMinus, Archive, BellOff, ListChecks,
  ArrowUpDown, Bot, Check, CircleSlash, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, Circle, CircleDot, Diff, Ellipsis, Eye, EyeOff, File, Files, FileText, FileX,
  FileX2, Focus, Folder, FolderGit2, FolderOpen, GitMerge, Hand, History, Image, Inbox, Info, Keyboard, Link, ListFilter, ListTree, LoaderCircle, Maximize2,
  MessageSquare, MessageSquarePlus, MoreHorizontal: Ellipsis, MoveRight, PanelLeftClose, PanelLeftOpen, Play, RefreshCw, Reply, Search, Send, Square,
  SquareCheck, StickyNote, Trash2, TriangleAlert, UnfoldHorizontal, WifiOff, X, Workflow, Move, ZoomIn, ZoomOut, Scan, GitCompare, Lock, Minimize2, ImageOff, Languages,
};

export type IconName = keyof typeof ICONS;

/** A Lucide icon; decorative (aria-hidden) unless it carries its own label. Size: the class or `size` (px). */
export function Icon({ name, className, style, size, ...aria }: { name: string; className?: string; style?: CSSProperties; size?: number; "aria-hidden"?: boolean | "true" | "false"; "aria-label"?: string }) {
  const Artwork = ICONS[name] ?? File;
  return <Artwork className={className} style={style} width={size} height={size} strokeWidth={1.75} aria-hidden={aria["aria-label"] ? undefined : true} aria-label={aria["aria-label"]} role={aria["aria-label"] ? "img" : undefined} />;
}
