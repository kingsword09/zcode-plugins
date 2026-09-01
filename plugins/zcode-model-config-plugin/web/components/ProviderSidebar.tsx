import { Plus, Trash2 } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { ProviderEntry } from "@shared/types";
import { styles } from "../styles";
import { t } from "../i18n";

export function ProviderSidebar(props: {
  providers: Record<string, ProviderEntry>;
  selectedId: string | null;
  mainRef?: string;
  liteRef?: string;
  onSelect: (providerId: string) => void;
  onAdd: () => void;
  onDelete?: () => void;
}): React.ReactElement {
  const entries = Object.entries(props.providers ?? {});
  return (
    <nav {...stylex.props(styles.sidebar)}>
      <div {...stylex.props(styles.sidebarTitle)}>
        {t("sidebar.providers")} · {entries.length}
      </div>
      {entries.map(([providerId, provider]) => {
        const isMain = props.mainRef?.startsWith(`${providerId}/`) ?? false;
        const isLite = props.liteRef?.startsWith(`${providerId}/`) ?? false;
        const modelCount = Object.keys(provider.models ?? {}).length;
        return (
          <button
            key={providerId}
            {...stylex.props(
              styles.providerItem,
              props.selectedId === providerId && styles.providerItemActive,
            )}
            onClick={() => props.onSelect(providerId)}
          >
            <span {...stylex.props(styles.providerItemTop)}>
              <span {...stylex.props(styles.providerName)}>{providerId}</span>
              <span>
                {isMain ? <span {...stylex.props(styles.roleBadge)}>main</span> : null}
                {isLite ? <span {...stylex.props(styles.roleBadge)}>lite</span> : null}
              </span>
            </span>
            <span {...stylex.props(styles.providerItemTop)}>
              <span>{provider.name ? <span {...stylex.props(styles.providerMeta)}>{provider.name}</span> : null}</span>
              <span {...stylex.props(styles.providerMeta)}>
                {modelCount} {t("sidebar.models")}
              </span>
            </span>
          </button>
        );
      })}
      <div {...stylex.props(styles.sidebarFooter)}>
        <button {...stylex.props(styles.buttonGhost, styles.iconWithGap)} onClick={props.onAdd}>
          <Plus size={14} strokeWidth={2} aria-hidden />
          {t("action.addProvider")}
        </button>
        {props.onDelete ? (
          <button {...stylex.props(styles.buttonDanger, styles.iconWithGap)} onClick={props.onDelete}>
            <Trash2 size={14} strokeWidth={2} aria-hidden />
            {t("action.deleteSelected")}
          </button>
        ) : null}
      </div>
    </nav>
  );
}
