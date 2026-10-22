import { createSignal } from "solid-js";
import type { SearchHit } from "../ipc/pdf";
export interface ActiveSearchMatch {
  tabId: string;
  revision: number;
  query: string;
  hit: SearchHit;
  navigation: number;
}
export const [activeSearchMatch, setActiveSearchMatch] =
  createSignal<ActiveSearchMatch | null>(null);
