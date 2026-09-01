import { Check } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { ModelConfigFile } from "@shared/types";
import { styles } from "../styles";
import { t } from "../i18n";

export function SaveDialog(props: {
  scope: "user" | "project";
  config: ModelConfigFile;
  targetPath: string;
  onCancel: () => void;
  onConfirm: () => void;
}): React.ReactElement {
  const modelKeys = {
    provider: Object.keys(props.config.provider ?? {}).length,
    models: Object.values(props.config.provider ?? {}).reduce((sum, p) => sum + Object.keys(p.models ?? {}).length, 0),
    main: props.config.model?.main ?? t("select.notSet"),
    lite: props.config.model?.lite ?? t("select.notSet"),
  };

  return (
    <div
      {...stylex.props(styles.dialogBackdrop)}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <div {...stylex.props(styles.dialog)}>
        <div {...stylex.props(styles.dialogHeader)}>
          <h2 {...stylex.props(styles.dialogTitle)}>{props.scope === "user" ? t("save.title.user") : t("save.title.project")}</h2>
        </div>
        <div {...stylex.props(styles.dialogBody)}>
          <p {...stylex.props(styles.muted)}>
            {t("save.target")}<code {...stylex.props(styles.providerMeta)}>{props.targetPath}</code>
          </p>
          <p {...stylex.props(styles.muted)}>
            {t("save.summary", { providers: modelKeys.provider, models: modelKeys.models, main: modelKeys.main, lite: modelKeys.lite })}
          </p>
          <p {...stylex.props(styles.muted)}>
            {t("save.note")}
          </p>
          <pre {...stylex.props(styles.pre)}>{JSON.stringify(props.config, null, 2)}</pre>
        </div>
        <div {...stylex.props(styles.dialogFooter)}>
          <button {...stylex.props(styles.buttonGhost)} onClick={props.onCancel}>
            {t("action.cancel")}
          </button>
          <button {...stylex.props(styles.buttonPrimary, styles.iconWithGap)} onClick={props.onConfirm}>
            <Check size={14} strokeWidth={2.2} aria-hidden />
            {t("action.save.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
