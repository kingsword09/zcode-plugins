import { Monitor, Moon, Sun } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import { styles } from "../styles";
import type { ThemeChoice } from "../useTheme";
import { t } from "../i18n";

export function ThemeSwitcher(props: {
  choice: ThemeChoice;
  onChange: (choice: ThemeChoice) => void;
}): React.ReactElement {
  // Render-time evaluation: labels follow the locale set after /api/state loads.
  const choices: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
    { value: "light", label: t("theme.light"), Icon: Sun },
    { value: "dark", label: t("theme.dark"), Icon: Moon },
    { value: "system", label: t("theme.system"), Icon: Monitor },
  ];
  return (
    <div {...stylex.props(styles.scopeTabs)} role="radiogroup" aria-label={t("theme.system")}>
      {choices.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          title={label}
          aria-label={label}
          {...stylex.props(styles.tab, styles.themeTab, props.choice === value && styles.tabActive)}
          aria-checked={props.choice === value}
          role="radio"
          onClick={() => props.onChange(value)}
        >
          <Icon size={14} strokeWidth={2} aria-hidden />
        </button>
      ))}
    </div>
  );
}
