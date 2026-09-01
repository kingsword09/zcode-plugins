import { useMemo, useState } from "react";
import { Brain, FileText, Image as ImageIcon, SquarePlay, Wrench } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { ModelEntry, Modality, ProviderEntry } from "@shared/types";
import type { GatewayModelDto } from "../api";
import { styles } from "../styles";
import { t } from "../i18n";
import { Select } from "./Select";

export function AddModelDialog(props: {
  providers: Record<string, ProviderEntry>;
  defaultProviderId: string | null;
  gatewayModels?: GatewayModelDto[] | null;
  onClose: () => void;
  onCreate: (providerId: string, modelId: string, model: ModelEntry) => void;
}): React.ReactElement {
  const providerIds = Object.keys(props.providers ?? {});
  const [providerId, setProviderId] = useState(
    props.defaultProviderId && props.providers[props.defaultProviderId] ? props.defaultProviderId : providerIds[0] ?? "",
  );
  const [idDraft, setIdDraft] = useState("");
  const [matchApplied, setMatchApplied] = useState(false);
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const [maxOutput, setMaxOutput] = useState("");
  const [image, setImage] = useState(false);
  const [video, setVideo] = useState(false);
  const [reasoning, setReasoning] = useState(false);
  const [toolCall, setToolCall] = useState(true);

  const trimmedId = idDraft.trim();
  const idTaken = Boolean(providerId && props.providers[providerId]?.models?.[trimmedId]);
  const canCreate = providerId !== "" && trimmedId !== "" && !idTaken;

  const matches = useMemo(() => {
    if (!props.gatewayModels || trimmedId === "") return null;
    const q = trimmedId.toLowerCase();
    const scored = props.gatewayModels
      .map((m) => {
        const id = m.id.toLowerCase();
        const key = m.modelKey.toLowerCase();
        const name = (m.name ?? "").toLowerCase();
        // aicode-style substring match over id / modelKey / name;
        // exact hits sort first.
        let score = -1;
        if (id === q || key === q) score = 0;
        else if (id.endsWith("/" + q) || key === q.replace(/^[^/]+\//, "")) score = 1;
        else if (id.includes(q) || name.includes(q) || (m.owner ?? "").toLowerCase().includes(q)) score = 2;
        return { m, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.m.id.localeCompare(b.m.id))
      .slice(0, 6)
      .map((x) => x.m);
    return scored.length > 0 ? scored : null;
  }, [props.gatewayModels, trimmedId]);

  const applyMatch = (m: GatewayModelDto) => {
    setIdDraft(m.modelKey);
    setMatchApplied(true);
    setName(m.name ?? m.modelKey);
    setContext(m.contextWindow ? String(m.contextWindow) : "");
    setMaxOutput(m.maxOutput ? String(m.maxOutput) : "");
    setImage(m.image);
    setVideo(false);
    setReasoning(m.reasoning);
    setToolCall(m.tools);
  };

  const create = () => {
    if (!canCreate || !providerId) return;
    const input: Modality[] = ["text"];
    if (image) input.push("image");
    if (video) input.push("video");
    const model: ModelEntry = {
      name: name.trim() || undefined,
      modalities: { input, output: ["text"] },
      ...(context || maxOutput
        ? { limit: { context: context ? Number(context) : undefined, output: maxOutput ? Number(maxOutput) : undefined } }
        : {}),
      reasoning: reasoning || undefined,
      tool_call: toolCall,
    };
    props.onCreate(providerId, trimmedId, model);
  };

  return (
    <div
      {...stylex.props(styles.dialogBackdrop)}
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div {...stylex.props(styles.dialog)} style={{ width: "min(720px, 100%)" }}>
        <div {...stylex.props(styles.dialogHeader)}>
          <h2 {...stylex.props(styles.dialogTitle)}>{t("dialog.addModel")}</h2>
        </div>
        <div {...stylex.props(styles.dialogBody)}>
          <div {...stylex.props(styles.formGridTwo)}>
            <div {...stylex.props(styles.field)}>
              <span {...stylex.props(styles.fieldLabel)}>{t("dialog.providerLabel")}</span>
              <Select
                value={providerId}
                onChange={setProviderId}
                options={providerIds.map((id) => ({ value: id, label: id, hint: props.providers[id]?.name }))}
                wide
                ariaLabel={t("dialog.providerLabel")}
              />
            </div>
            <label {...stylex.props(styles.field)}>
              <span {...stylex.props(styles.fieldLabel)}>{t("model.editor.id")}</span>
              <input
                {...stylex.props(styles.input, styles.inputMono)}
                value={idDraft}
                autoFocus
                placeholder="e.g. glm-5.2"
                onChange={(event) => {
                  setIdDraft(event.target.value);
                  setMatchApplied(false);
                }}
              />
            </label>
          </div>

          {idTaken ? <p {...stylex.props(styles.errorText)}>{t("dialog.idExists")}</p> : null}

          {matches && !matchApplied ? (
            <div {...stylex.props(styles.matchBar)}>
              <div {...stylex.props(styles.matchText)}>
                {t("model.editor.matchFound")}
                {matches.length > 1
                  ? ` (${t("model.editor.matchProviders", { n: matches.length })})`
                  : ""}
              </div>
              {matches.map((m) => (
                <div key={m.id} {...stylex.props(styles.matchRow)}>
                  <span {...stylex.props(styles.matchText)}>
                    <span {...stylex.props(styles.matchStrong)}>{m.modelKey}</span>
                    {m.owner ? ` · ${m.owner}` : ""}
                    {m.name && m.name !== m.modelKey ? ` · ${m.name}` : ""}
                    {m.contextWindow ? ` · ${Math.round(m.contextWindow / 1000)}k` : ""}
                    {m.image ? " · 👁" : ""}
                    {m.reasoning ? " · 🧠" : ""}
                    {m.tools ? " · 🔧" : ""}
                  </span>
                  <button {...stylex.props(styles.matchApply)} onClick={() => applyMatch(m)}>
                    {t("model.editor.apply")}
                  </button>
                </div>
              ))}
            </div>
          ) : trimmedId !== "" && props.gatewayModels && !matchApplied ? (
            <p {...stylex.props(styles.noMatchText)}>{t("model.editor.noMatch")}</p>
          ) : null}

          <div {...stylex.props(styles.formGridTwo)}>
            <label {...stylex.props(styles.field)}>
              <span {...stylex.props(styles.fieldLabel)}>{t("model.editor.name")}</span>
              <input
                {...stylex.props(styles.input)}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div {...stylex.props(styles.formGridTwo)}>
              <label {...stylex.props(styles.field)}>
                <span {...stylex.props(styles.fieldLabel)}>{t("model.editor.context")}</span>
                <input
                  {...stylex.props(styles.input, styles.inputMono)}
                  type="number"
                  min={1}
                  value={context}
                  onChange={(event) => setContext(event.target.value)}
                />
              </label>
              <label {...stylex.props(styles.field)}>
                <span {...stylex.props(styles.fieldLabel)}>{t("model.editor.maxOutput")}</span>
                <input
                  {...stylex.props(styles.input, styles.inputMono)}
                  type="number"
                  min={1}
                  value={maxOutput}
                  onChange={(event) => setMaxOutput(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div>
            <div {...stylex.props(styles.sidebarTitle)}>{t("model.editor.capabilities")}</div>
            <div {...stylex.props(styles.switchRow)}>
              <div>
                <div {...stylex.props(styles.switchLabel)}>{t("model.editor.inputModalities")}</div>
                <div {...stylex.props(styles.switchHint)}>text / image / video</div>
              </div>
              <div {...stylex.props(styles.filterRow)}>
                <span {...stylex.props(styles.modChip, styles.modChipOn, styles.modChipLocked)}>
                  <FileText size={13} strokeWidth={2.2} aria-hidden />
                  {t("modality.text")}
                </span>
                <button
                  type="button"
                  {...stylex.props(styles.modChip, image && styles.modChipOn)}
                  role="switch"
                  aria-checked={image}
                  onClick={() => setImage(!image)}
                >
                  <ImageIcon size={13} strokeWidth={2.2} aria-hidden />
                  {t("modality.image")}
                </button>
                <button
                  type="button"
                  {...stylex.props(styles.modChip, video && styles.modChipOn)}
                  role="switch"
                  aria-checked={video}
                  onClick={() => setVideo(!video)}
                >
                  <SquarePlay size={13} strokeWidth={2.2} aria-hidden />
                  {t("modality.video")}
                </button>
              </div>
            </div>
            <div {...stylex.props(styles.switchRow)}>
              <div>
                <div {...stylex.props(styles.switchLabel)}>{t("model.editor.reasoning")}</div>
                <div {...stylex.props(styles.switchHint)}>{t("model.editor.reasoningHint")}</div>
              </div>
              <button
                {...stylex.props(styles.toggle, reasoning && styles.toggleOn)}
                role="switch"
                aria-checked={reasoning}
                onClick={() => setReasoning(!reasoning)}
              />
            </div>
            <div {...stylex.props(styles.switchRow, styles.switchRowLast)}>
              <div>
                <div {...stylex.props(styles.switchLabel)}>{t("model.editor.tools")}</div>
              </div>
              <button
                {...stylex.props(styles.toggle, toolCall && styles.toggleOn)}
                role="switch"
                aria-checked={toolCall}
                onClick={() => setToolCall(!toolCall)}
              />
            </div>
          </div>
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
            <Wrench size={14} strokeWidth={2.2} aria-hidden />
            {t("dialog.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
