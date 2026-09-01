import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";

const STORAGE_KEY = "mc-theme";

function systemPrefersLight(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches;
}

function resolve(choice: ThemeChoice): "light" | "dark" {
  if (choice === "system") return systemPrefersLight() ? "light" : "dark";
  return choice;
}

function apply(resolved: "light" | "dark"): void {
  const root = document.documentElement;
  root.classList.toggle("theme-light", resolved === "light");
  root.classList.toggle("theme-dark", resolved === "dark");
}

/**
 * Theme state (light / dark / follow-system). Applies the resolved theme as a
 * class on <html>; `theme.css` defines the CSS variable sets. System mode
 * live-follows `prefers-color-scheme` changes.
 */
export function useTheme(): {
  choice: ThemeChoice;
  resolved: "light" | "dark";
  setChoice: (choice: ThemeChoice) => void;
} {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolve(choice));

  useEffect(() => {
    setResolved(resolve(choice));
    localStorage.setItem(STORAGE_KEY, choice);
  }, [choice]);

  useEffect(() => {
    apply(resolved);
  }, [resolved]);

  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setResolved(systemPrefersLight() ? "light" : "dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => setChoiceState(next), []);
  return { choice, resolved, setChoice };
}
