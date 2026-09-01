import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { ProviderEntry } from "@shared/types";
import { styles } from "../styles";
import { t } from "../i18n";
import { Select } from "./Select";

export function AddProviderDialog(props: {
  existingIds: string[];
  onClose: () => void;
  onCreate: (providerId: string, provider: ProviderEntry) => void;
}): React.ReactElement {
  const [idDraft, setIdDraft] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<NonNullable<ProviderEntry["kind"]>>("openai-compatible");
  const [baseURL, setBaseURL] = useState("");
  const [apiKey, setApiKey] = useState("");

  const trimmedId = idDraft.trim();
  const idTaken = useMemo(() => props.existingIds.includes(trimmedId), [props.existingIds, trimmedId]);
  const needsBaseURL = kind === "openai-compatible" && baseURL.trim() === "";
  const canCreate = trimmedId !== "" && !idTaken && !needsBaseURL;

  const create = () => {
    if (!canCreate) return;
    const provider: ProviderEntry = {
      kind,
      name: name.trim() || undefined,
      options: {
        baseURL: baseURL.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      },
    };
    props.onCreate(trimmedId, provider);
  };

  return (
    <div
      {...stylex.props(styles.dialogBackdrop)}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div {...stylex.props(styles.dialog)} style={{ width: "min(640px, 100%)" }}>
        <div {...stylex.props(styles.dialogHeader)}>
          <h2 {...stylex.props(styles.dialogTitle)}>{t("dialog.addProvider")}</h2>
        </div>
        <div {...stylex.props(styles.dialogBody)}>
          <div {...stylex.props(styles.formGridTwo)}>
            <label {...stylex.props(styles.field)}>
              <span {...stylex.props(styles.fieldLabel)}>{t("provider.id")}</span>
              <input
                {...stylex.props(styles.input, styles.inputMono)}
                value={idDraft}
                autoFocus
                placeholder="e.g. my-gateway"
                onChange={(event) => setIdDraft(event.target.value)}
              />
            </label>
            <label {...stylex.props(styles.field)}>
              <span {...stylex.props(styles.fieldLabel)}>{t("provider.name")}</span>
              <input
                {...stylex.props(styles.input)}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          </div>
          {idTaken ? <p {...stylex.props(styles.errorText)}>{t("dialog.idExists")}</p> : null}

          <div {...stylex.props(styles.formGridTwo)}>
            <div {...stylex.props(styles.field)}>
              <span {...stylex.props(styles.fieldLabel)}>{t("provider.kind")}</span>
              <Select
                value={kind}
                onChange={(value) => setKind(value as NonNullable<ProviderEntry["kind"]>)}
                options={[
                  { value: "openai-compatible", label: t("provider.kindOpenaiCompatible"), hint: t("provider.kindOpenaiCompatibleHint") },
                  { value: "openai", label: "openai" },
                  { value: "anthropic", label: "anthropic" },
                ]}
                wide
                ariaLabel={t("provider.kind")}
              />
            </div>
            <label {...stylex.props(styles.field)}>
              <span {...stylex.props(styles.fieldLabel)}>{t("provider.baseURL")}</span>
              <input
                {...stylex.props(styles.input, styles.inputMono)}
                placeholder="https://api.example.com/v1"
                value={baseURL}
                onChange={(event) => setBaseURL(event.target.value)}
              />
            </label>
          </div>
          {needsBaseURL ? <p {...stylex.props(styles.errorText)}>{t("dialog.baseURLRequired")}</p> : null}

          <label {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.fieldLabel)}>{t("provider.apiKey")}</span>
            <input
              {...stylex.props(styles.input, styles.inputMono)}
              type="password"
              placeholder="sk-…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        </div>
        <div {...stylex.props(styles.dialogFooter)}>
          <button {...stylex.props(styles.buttonGhost)} onClick={props.onClose}>
            {t("action.cancel")}
          </button>
          <button
            {...stylex.props(styles.buttonPrimary, styles.iconWithGap)}
            disabled={!canCreate}
            onClick={create}
          >
            <Plus size={14} strokeWidth={2.2} aria-hidden />
            {t("dialog.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
