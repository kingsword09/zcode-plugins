import { useMemo, useState } from "react";
import { Brain, FileText, Image, Plus, Search, SquarePlay, Trash2, Wrench, type LucideIcon } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { ModelEntry, ProviderEntry } from "@shared/types";
import { styles } from "../styles";
import { Select } from "./Select";
import { t } from "../i18n";

type Modality = NonNullable<ModelEntry["modalities"]>["input"];

export function ProviderDetail(props: {
  providerId: string;
  onAddModel?: () => void;
  provider?: ProviderEntry;
  models: Record<string, ModelEntry>;
  onChange: (provider: ProviderEntry) => void;
}): React.ReactElement {
  const provider = props.provider;
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [idDraftReset, setIdDraftReset] = useState(0);
  const [modelSearch, setModelSearch] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const modelEntries = useMemo(() => {
    // 空格分词 AND 匹配
    const terms = modelSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return Object.entries(props.models).filter(([id, model]) =>
      terms.length === 0
        ? true
        : terms.every((term) => `${id} ${model.name ?? ""}`.toLowerCase().includes(term)),
    );
  }, [props.models, modelSearch]);

  if (!provider) {
    return (
      <section {...stylex.props(styles.detail)}>
        <div {...stylex.props(styles.panel)}>
          <p {...stylex.props(styles.muted)}>
            {props.providerId
              ? t("provider.notFound", { id: props.providerId })
              : t("provider.emptyHint")}
          </p>
        </div>
      </section>
    );
  }

  const patch = (partial: Partial<ProviderEntry>) => props.onChange({ ...provider, ...partial });
  const patchOptions = (partial: Partial<NonNullable<ProviderEntry["options"]>>) =>
    patch({ options: { ...(provider.options ?? {}), ...partial } });
  const patchModel = (modelId: string, partial: Partial<ModelEntry>) =>
    patch({ models: { ...(provider.models ?? {}), [modelId]: { ...props.models[modelId], ...partial } } });
  const renameModel = (oldId: string, newId: string): boolean => {
    const id = newId.trim();
    if (!id || id === oldId || props.models[id]) return false;
    const models = { ...(provider.models ?? {}) };
    const entry = models[oldId];
    delete models[oldId];
    models[id] = entry ?? { name: id };
    patch({ models });
    setExpandedModel(id);
    return true;
  };
  const deleteModel = (modelId: string) => {
    const next = { ...(provider.models ?? {}) };
    delete next[modelId];
    patch({ models: next });
  };

  return (
    <section {...stylex.props(styles.detail)}>
      <div {...stylex.props(styles.panel)}>
        <h2 {...stylex.props(styles.sectionTitle)}>{t("provider.settings")} — {props.providerId}</h2>
        <div {...stylex.props(styles.formGrid)}>
          <label {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.fieldLabel)}>{t("provider.id")}</span>
            <input
              {...stylex.props(styles.input, styles.inputMono)}
              value={props.providerId}
              readOnly
              title={t("provider.idTitle")}
            />
          </label>
          <label {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.fieldLabel)}>{t("provider.name")}</span>
            <input
              {...stylex.props(styles.input)}
              value={provider.name ?? ""}
              onChange={(event) => patch({ name: event.target.value || undefined })}
            />
          </label>
          <div {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.fieldLabel)}>{t("provider.kind")}</span>
            <Select
              value={provider.kind ?? "openai-compatible"}
              onChange={(value) => patch({ kind: value as ProviderEntry["kind"] })}
              options={[
                { value: "openai-compatible", label: t("provider.kindOpenaiCompatible"), hint: t("provider.kindOpenaiCompatibleHint") },
                { value: "openai", label: "openai" },
                { value: "anthropic", label: "anthropic" },
              ]}
              ariaLabel={t("provider.kind")}
            />
          </div>
          <label {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.fieldLabel)}>{t("provider.baseURL")}</span>
            <input
              {...stylex.props(styles.input, styles.inputMono)}
              placeholder="https://api.example.com/v1"
              value={provider.options?.baseURL ?? ""}
              onChange={(event) => patchOptions({ baseURL: event.target.value || undefined })}
            />
          </label>
          <label {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.fieldLabel)}>{t("provider.apiKey")}</span>
            <input
              {...stylex.props(styles.input, styles.inputMono)}
              type="password"
              placeholder="sk-…"
              value={typeof provider.options?.apiKey === "string" ? provider.options.apiKey : ""}
              onChange={(event) => patchOptions({ apiKey: event.target.value || undefined })}
            />
          </label>
        </div>
      </div>

      <div {...stylex.props(styles.panel)}>
        <h2 {...stylex.props(styles.sectionTitle)}>{t("model.count", { n: Object.keys(props.models).length })}</h2>
        <div {...stylex.props(styles.tableToolbar)}>
          <div {...stylex.props(styles.inputIconWrap)}>
            <span {...stylex.props(styles.inputIconLead)}>
              <Search size={14} strokeWidth={2} aria-hidden />
            </span>
            <input
              {...stylex.props(styles.input, styles.inputWithLead)}
              placeholder={t("model.search")}
              value={modelSearch}
              onChange={(event) => setModelSearch(event.target.value)}
            />
          </div>
          <button
            {...stylex.props(styles.buttonGhost, styles.iconWithGap)}
            onClick={() => props.onAddModel?.()}
          >
            <Plus size={14} strokeWidth={2} aria-hidden />
            {t("action.addModel")}
          </button>
        </div>
        <table {...stylex.props(styles.modelTable)}>
          <thead>
            <tr {...stylex.props(styles.modelHeaderRow)}>
              <th {...stylex.props(styles.modelHeaderCell)}>{t("model.idName")}</th>
              <th {...stylex.props(styles.modelHeaderCell)}>{t("model.capabilities")}</th>
              <th {...stylex.props(styles.modelHeaderCell)}>{t("model.contextOutput")}</th>
              <th {...stylex.props(styles.modelHeaderCell)}></th>
            </tr>
          </thead>
          <tbody>
            {modelEntries.map(([modelId, model]) => {
              const input = model.modalities?.input ?? [];
              const multimodal =
                model.attachment === true || input.includes("image") || input.includes("pdf") || input.includes("video");
              const expanded = expandedModel === modelId;
              return (
                <>
                  <tr
                    key={modelId}
                    {...stylex.props(styles.modelRow, expanded && styles.modelRowExpanded)}
                    onClick={() => setExpandedModel(expanded ? null : modelId)}
                  >
                    <td {...stylex.props(styles.modelCell)}>
                      <span {...stylex.props(styles.providerName)}>{modelId}</span>
                      {model.name ? <span {...stylex.props(styles.providerMeta)}> · {model.name}</span> : null}
                    </td>
                    <td {...stylex.props(styles.modelCell)}>
                      <CapabilityChips model={model} />
                    </td>
                    <td {...stylex.props(styles.modelCell)}>
                      <span {...stylex.props(styles.providerMeta)}>
                        {model.limit?.context ?? model.contextWindow ?? "-"} / {model.limit?.output ?? model.maxOutputTokens ?? "-"}
                      </span>
                    </td>
                    <td {...stylex.props(styles.modelCellRight)}>
                      <button
                        {...stylex.props(styles.buttonSmall, styles.iconOnly)}
                        title={t("action.deleteModel")}
                        aria-label={`${t("action.deleteModel")} ${modelId}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteModel(modelId);
                        }}
                      >
                        <Trash2 size={14} strokeWidth={2} aria-hidden />
                      </button>
                    </td>
                  </tr>
                  {expanded ? (
                    <tr key={`${modelId}-expanded`}>
                      <td colSpan={4} {...stylex.props(styles.modelCell)}>
                        <ModelEditor
                          key={`${modelId}:${idDraftReset}`}
                          modelId={modelId}
                          model={model}
                          multimodal={multimodal}
                          onRename={(newId) => renameModel(modelId, newId)}
                          onChange={(partial) => patchModel(modelId, partial)}
                        />
                      </td>
                    </tr>
                  ) : null}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      <div {...stylex.props(styles.panel)}>
        <h2 {...stylex.props(styles.sectionTitle)}>{t("model.rawJson")}</h2>
        {jsonError ? <p {...stylex.props(styles.errorText)}>{jsonError}</p> : null}
        <textarea
          {...stylex.props(styles.textarea)}
          // key 含 provider 全量序列化：切换 provider 或表单变更后重建，
          // 让 defaultValue 跟随最新数据（输入中 props 不变，不重建）
          key={`${props.providerId}:${JSON.stringify(provider)}`}
          defaultValue={JSON.stringify(provider, null, 2)}
          onBlur={(event) => {
            try {
              const parsed = JSON.parse(event.target.value) as ProviderEntry;
              setJsonError(null);
              props.onChange(parsed);
            } catch (error) {
              setJsonError(error instanceof Error ? error.message : String(error));
            }
          }}
        />
      </div>
    </section>
  );
}

function CapabilityChips(props: { model: ModelEntry }): React.ReactElement {
  const input = props.model.modalities?.input ?? [];
  const chips: [string, LucideIcon, boolean][] = [
    ["cap.image", Image, props.model.supportsImages === true || input.includes("image")],
    ["cap.pdf", FileText, props.model.supportsPdf === true || input.includes("pdf")],
    ["cap.video", SquarePlay, props.model.supportsVideo === true || input.includes("video")],
    ["cap.reasoning", Brain, props.model.reasoning !== undefined && props.model.reasoning !== false],
    ["cap.tools", Wrench, props.model.tool_call !== false],
  ];
  return (
    <>
      {chips
        .filter(([, , on]) => on)
        .map(([key, Icon]) => (
          <span key={key} {...stylex.props(styles.chip, styles.chipOn)}>
            <span {...stylex.props(styles.chipIcon)}>
              <Icon size={11} strokeWidth={2.2} aria-hidden />
            </span>
            {t(key)}
          </span>
        ))}
    </>
  );
}

function Toggle(props: { on: boolean; onChange: (on: boolean) => void; label: string; hint?: string }): React.ReactElement {
  return (
    <div {...stylex.props(styles.switchRow)}>
      <div>
        <div {...stylex.props(styles.switchLabel)}>{props.label}</div>
        {props.hint ? <div {...stylex.props(styles.switchHint)}>{props.hint}</div> : null}
      </div>
      <button
        {...stylex.props(styles.toggle, props.on && styles.toggleOn)}
        role="switch"
        aria-checked={props.on}
        onClick={() => props.onChange(!props.on)}
      />
    </div>
  );
}

function ModelEditor(props: {
  modelId: string;
  model: ModelEntry;
  multimodal: boolean;
  hideMatch?: boolean;
  onRename?: (newId: string) => boolean;
  onChange: (partial: Partial<ModelEntry>) => void;
}): React.ReactElement {
  const input = props.model.modalities?.input ?? ["text"];
  const output = props.model.modalities?.output ?? ["text"];

  // ── Editable model ID ────────────────────────────────────
  const [idDraft, setIdDraft] = useState(props.modelId);
  const trimmedId = idDraft.trim();
  const idChanged = trimmedId !== props.modelId && trimmedId.length > 0;

  const toggleModality = (kind: "image" | "video", on: boolean) => {
    const set = new Set(input);
    if (on) set.add(kind);
    else set.delete(kind);
    set.add("text");
    props.onChange({
      // 旧格式冗余字段（若存在）一并清除，只保留 modalities 作为唯一多模态表达
      attachment: undefined,
      supportsImages: undefined,
      supportsVideo: undefined,
      modalities: { input: [...set], output },
    });
  };

  const renderModChip = (kind: "image" | "video", label: string, Icon: LucideIcon) => {
    const on = input.includes(kind);
    return (
      <button
        key={kind}
        type="button"
        {...stylex.props(styles.modChip, on && styles.modChipOn)}
        role="switch"
        aria-checked={on}
        onClick={() => toggleModality(kind, !on)}
      >
        <Icon size={13} strokeWidth={2.2} aria-hidden />
        {label}
      </button>
    );
  };

  return (
    <div {...stylex.props(styles.panel)} style={{ display: "grid", gap: 16 }}>
      <div {...stylex.props(styles.formGrid)}>
        <label {...stylex.props(styles.field)}>
          <span {...stylex.props(styles.fieldLabel)}>{t("model.editor.id")}</span>
          <input
            {...stylex.props(styles.input, styles.inputMono)}
            value={idDraft}
            onChange={(event) => setIdDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && idChanged) {
                if (!props.onRename?.(trimmedId)) event.preventDefault();
              }
            }}
            onBlur={() => {
              if (idChanged) props.onRename?.(trimmedId);
            }}
          />
        </label>
        <label {...stylex.props(styles.field)}>
          <span {...stylex.props(styles.fieldLabel)}>{t("model.editor.name")}</span>
          <input
            {...stylex.props(styles.input)}
            value={props.model.name ?? ""}
            onChange={(event) => props.onChange({ name: event.target.value || undefined })}
          />
        </label>
        <label {...stylex.props(styles.field)}>
          <span {...stylex.props(styles.fieldLabel)}>{t("model.editor.context")}</span>
          <input
            {...stylex.props(styles.input, styles.inputMono)}
            type="number"
            min={1}
            value={props.model.limit?.context ?? props.model.contextWindow ?? ""}
            onChange={(event) =>
              props.onChange({
                limit: {
                  context: event.target.value ? Number(event.target.value) : undefined,
                  output: props.model.limit?.output,
                },
              })
            }
          />
        </label>
        <label {...stylex.props(styles.field)}>
          <span {...stylex.props(styles.fieldLabel)}>{t("model.editor.maxOutput")}</span>
          <input
            {...stylex.props(styles.input, styles.inputMono)}
            type="number"
            min={1}
            value={props.model.limit?.output ?? props.model.maxOutputTokens ?? ""}
            onChange={(event) =>
              props.onChange({
                limit: {
                  context: props.model.limit?.context,
                  output: event.target.value ? Number(event.target.value) : undefined,
                },
              })
            }
          />
        </label>
      </div>

      <div>
        <div {...stylex.props(styles.sidebarTitle)}>{t("model.editor.capabilities")}</div>

        <div {...stylex.props(styles.switchRow)}>
          <div>
            <div {...stylex.props(styles.switchLabel)}>{t("model.editor.inputModalities")}</div>
            <div {...stylex.props(styles.switchHint)}>text / image / video</div>
          </div>
          <div {...stylex.props(styles.filterRow)}>
            <span
              {...stylex.props(styles.modChip, styles.modChipOn, styles.modChipLocked)}
              title="text"
            >
              <FileText size={13} strokeWidth={2.2} aria-hidden />
              {t("modality.text")}
            </span>
            {renderModChip("image", t("modality.image"), Image)}
            {renderModChip("video", t("modality.video"), SquarePlay)}
          </div>
        </div>

        <Toggle
          label={t("model.editor.reasoning")}
          hint={t("model.editor.reasoningHint")}
          on={props.model.reasoning !== undefined && props.model.reasoning !== false}
          onChange={(on) => props.onChange({ reasoning: on || false })}
        />
        <Toggle
          label={t("model.editor.tools")}
          on={props.model.tool_call !== false}
          onChange={(on) => props.onChange({ tool_call: on })}
        />
        <div {...stylex.props(styles.switchRowLast)} />
      </div>
    </div>
  );
}
