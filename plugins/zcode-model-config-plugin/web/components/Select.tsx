import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { t } from "../i18n";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../styles";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  group?: string;
}

/**
 * Modern listbox-style select: button trigger + floating menu panel with
 * grouped options, keyboard navigation (↑ ↓ Enter Esc) and click-outside
 * close. Replaces native <select> for a consistent look across themes.
 */
export function Select(props: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  wide?: boolean;
  ariaLabel?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => props.options.find((o) => o.value === props.value), [props.options, props.value]);
  const flat = useMemo(() => props.options.filter((o) => !o.group), [props.options]);
  // groups preserved in original order
  const groups = useMemo(() => {
    const out: { group: string; items: SelectOption[] }[] = [];
    for (const o of props.options) {
      if (o.group) {
        let g = out.find((x) => x.group === o.group);
        if (!g) {
          g = { group: o.group, items: [] };
          out.push(g);
        }
        g.items.push(o);
      }
    }
    return { grouped: out, ungrouped: flat };
  }, [props.options, flat]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Fixed positioning measured from the trigger's viewport rect — immune to
    // offsetParent surprises (transforms, filters, grid containers).
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = Math.max(rect.width, 220);
      setMenuPos({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
        top: rect.bottom + 6,
        width: rect.width,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.focus();
    if (selected) {
      const idx = props.options.findIndex((o) => o.value === props.value);
      setActiveIndex(idx);
    }
  }, [open, props.options, props.value, selected]);

  const commit = (index: number) => {
    const opt = props.options[index];
    if (!opt) return;
    props.onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, props.options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(activeIndex);
    }
  };

  const renderOption = (opt: SelectOption) => {
    const idx = props.options.indexOf(opt);
    const isActive = idx === activeIndex;
    const isSelected = opt.value === props.value;
    return (
      <button
        key={opt.value}
        type="button"
        {...stylex.props(styles.menuItem, isActive && styles.menuItemActive)}
        onMouseEnter={() => setActiveIndex(idx)}
        onClick={() => commit(idx)}
      >
        <span {...stylex.props(styles.selectValue)}>
          {opt.label}
          {opt.hint ? <span {...stylex.props(styles.menuItemHint)}> · {opt.hint}</span> : null}
        </span>
        {isSelected ? (
          <span {...stylex.props(styles.menuItemCheck)}>
            <Check size={13} strokeWidth={2.4} aria-hidden />
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div ref={rootRef} style={{ display: props.wide ? "block" : "inline-block" }} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        {...stylex.props(styles.selectTrigger, props.wide && styles.selectTriggerWide)}
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span {...stylex.props(styles.selectValue, !selected && styles.selectPlaceholder)}>
          {selected ? selected.label : (props.placeholder ?? t("select.notSet"))}
        </span>
        <ChevronDown
          {...stylex.props(styles.selectCaret, open && styles.selectCaretOpen)}
          size={14}
          strokeWidth={2}
          aria-hidden
        />
      </button>
      {open && menuPos ? (
        <>
          <div {...stylex.props(styles.menuBackdrop)} onClick={() => setOpen(false)} />
          <div
            ref={menuRef}
            role="listbox"
            tabIndex={-1}
            {...stylex.props(styles.menuPanel)}
            style={{
              position: "fixed",
              left: menuPos.left,
              top: menuPos.top,
              width: menuPos.width,
            }}
          >
            {props.options.length === 0 ? (
              <div {...stylex.props(styles.menuEmpty)}>{t("select.empty")}</div>
            ) : (
              <>
                {groups.ungrouped.map(renderOption)}
                {groups.grouped.map((g) => (
                  <div key={g.group}>
                    <div {...stylex.props(styles.menuGroup)}>{g.group}</div>
                    {g.items.map(renderOption)}
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
