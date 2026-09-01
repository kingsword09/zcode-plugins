import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Power, Save } from "lucide-react";
import * as stylex from "@stylexjs/stylex";
import type { ModelConfigFile, Modality, ProviderEntry } from "@shared/types";
import {
  fetchGatewayModels,
  fetchState,
  saveConfig,
  shutdownServer,
  type GatewayModelDto,
  type StateDto,
} from "./api";
import { styles } from "./styles";
import { ProviderSidebar } from "./components/ProviderSidebar";
import { ProviderDetail } from "./components/ProviderDetail";
import { SaveDialog } from "./components/SaveDialog";
import { ThemeSwitcher } from "./components/ThemeSwitcher";
import { AddModelDialog } from "./components/AddModelDialog";
import { AddProviderDialog } from "./components/AddProviderDialog";
import { Select, type SelectOption } from "./components/Select";
import { useTheme } from "./useTheme";
import { setLocale, t } from "./i18n";

type Scope = "user" | "project";

interface EditorState {
  loaded: boolean;
  stateInfo: StateDto["state"] | null;
  scope: Scope;
  /** Working copies of both config files (model keys only). */
  configs: Record<Scope, ModelConfigFile>;
  selectedProviderId: string | null;
}

type EditorAction =
  | { type: "loaded"; state: StateDto["state"] }
  | { type: "scope"; scope: Scope }
  | { type: "select"; providerId: string | null }
  | { type: "upsertProvider"; providerId: string; provider: ProviderEntry }
  | { type: "deleteProvider"; providerId: string }
  | { type: "patchConfig"; config: ModelConfigFile };

function cloneConfig(config: ModelConfigFile): ModelConfigFile {
  return JSON.parse(JSON.stringify(config ?? {})) as ModelConfigFile;
}

function reducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "loaded":
      return {
        ...state,
        loaded: true,
        stateInfo: action.state,
        configs: {
          user: cloneConfig(action.state.user.config ?? {}),
          project: cloneConfig(action.state.project.config ?? {}),
        },
        selectedProviderId: Object.keys(action.state.user.config?.provider ?? {})[0] ?? null,
      };
    case "scope":
      return {
        ...state,
        scope: action.scope,
        selectedProviderId:
          Object.keys(state.configs[action.scope].provider ?? {})[0] ?? null,
      };
    case "select":
      return { ...state, selectedProviderId: action.providerId };
    case "upsertProvider": {
      const config = cloneConfig(state.configs[state.scope]);
      config.provider = { ...(config.provider ?? {}), [action.providerId]: action.provider };
      return { ...state, configs: { ...state.configs, [state.scope]: config }, selectedProviderId: action.providerId };
    }
    case "deleteProvider": {
      const config = cloneConfig(state.configs[state.scope]);
      if (config.provider) {
        delete config.provider[action.providerId];
      }
      const remaining = Object.keys(config.provider ?? {});
      return {
        ...state,
        configs: { ...state.configs, [state.scope]: config },
        selectedProviderId:
          state.selectedProviderId === action.providerId ? (remaining[0] ?? null) : state.selectedProviderId,
      };
    }
    case "patchConfig": {
      const config = cloneConfig(action.config);
      return { ...state, configs: { ...state.configs, [state.scope]: config } };
    }
    default:
      return state;
  }
}

export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, {
    loaded: false,
    stateInfo: null,
    scope: "user",
    configs: { user: {}, project: {} },
    selectedProviderId: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [gatewayModels, setGatewayModels] = useState<GatewayModelDto[] | null>(null);
  const theme = useTheme();

  useEffect(() => {
    // 供新增模型的 auto-match 使用；离线时静默降级为纯手动配置
    fetchGatewayModels()
      .then((result) => setGatewayModels(result.models))
      .catch(() => setGatewayModels(null));
  }, []);

  useEffect(() => {
    fetchState()
      .then((result) => {
        setLocale(result.state.locale);
        dispatch({ type: "loaded", state: result.state });
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const config = state.configs[state.scope];
  const providers = config.provider ?? {};
  const selectedProvider = state.selectedProviderId ? providers[state.selectedProviderId] : undefined;

  const allModels = useMemo(() => {
    const out: { providerId: string; modelId: string; name?: string; multimodal: boolean }[] = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        const input = model.modalities?.input ?? [];
        out.push({
          providerId,
          modelId,
          name: typeof model.name === "string" ? model.name : undefined,
          multimodal: model.attachment === true || model.supportsImages === true || input.includes("image"),
        });
      }
    }
    return out;
  }, [providers]);

  const onSave = useCallback(async () => {
    setSaveOpen(false);
    try {
      const result = await saveConfig(state.scope, config);
      setSavedMessage(t("save.done", { path: result.path, backup: result.backupPath ? t("save.backupSuffix", { path: result.backupPath }) : "" }));
      setTimeout(() => setSavedMessage(null), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [config, state.scope]);


  if (error) {
    return (
      <div {...stylex.props(styles.page)}>
        <div {...stylex.props(styles.panel)}>
          <h1 {...stylex.props(styles.title)}>{t("app.loadFailed")}</h1>
          <p {...stylex.props(styles.muted)}>{error}</p>
        </div>
      </div>
    );
  }

  if (!state.loaded) {
    return (
      <div {...stylex.props(styles.page)}>
        <p {...stylex.props(styles.muted)}>{t("app.loading")}</p>
      </div>
    );
  }

  const fileInfo = state.scope === "user" ? state.stateInfo?.user : state.stateInfo?.project;

  return (
    <div {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.headerLeft)}>
          <h1 {...stylex.props(styles.title)}>{t("app.title")}</h1>
          <div {...stylex.props(styles.scopeTabs)}>
            <button
              {...stylex.props(styles.tab, state.scope === "user" && styles.tabActive)}
              onClick={() => dispatch({ type: "scope", scope: "user" })}
            >{t("scope.user")}
            </button>
            <button
              {...stylex.props(styles.tab, state.scope === "project" && styles.tabActive)}
              onClick={() => dispatch({ type: "scope", scope: "project" })}
            >{t("scope.project")}
            </button>
          </div>
          <span {...stylex.props(styles.pathChip)}>{fileInfo?.path ?? ""}</span>
        </div>
        <div {...stylex.props(styles.headerRight)}>
          <ThemeSwitcher choice={theme.choice} onChange={theme.setChoice} />
          <ModelRoleSelect
            label="main"
            value={config.model?.main ?? ""}
            models={allModels}
            onChange={(value) =>
              dispatch({
                type: "patchConfig",
                config: { ...config, model: { ...config.model, main: value || undefined } },
              })
            }
          />
          <ModelRoleSelect
            label="lite"
            value={config.model?.lite ?? ""}
            models={allModels}
            onChange={(value) =>
              dispatch({
                type: "patchConfig",
                config: { ...config, model: { ...config.model, lite: value || undefined } },
              })
            }
          />
          <button
            {...stylex.props(styles.buttonGhost, styles.iconWithGap)}
            title={t("action.stopServer")}
            aria-label={t("action.stopServer")}
            onClick={async () => {
              await shutdownServer();
            }}
          >
            <Power size={15} strokeWidth={2} aria-hidden />
          </button>
          <button
            {...stylex.props(styles.buttonPrimary, styles.iconOnly)}
            title={t("action.save")}
            aria-label={t("action.save")}
            onClick={() => setSaveOpen(true)}
          >
            <Save size={15} strokeWidth={2.2} aria-hidden />
          </button>
        </div>
      </header>

      {state.stateInfo?.project.parseError || state.stateInfo?.user.parseError ? (
        <div {...stylex.props(styles.bannerWarn)}>
          {t("banner.parseError")}
          {state.stateInfo.user.parseError ? ` ${t("scope.user")} (${state.stateInfo.user.parseError})` : ""}
          {state.stateInfo.project?.parseError ? ` ${t("scope.project")} (${state.stateInfo.project.parseError})` : ""}
        </div>
      ) : null}
      {savedMessage ? <div {...stylex.props(styles.bannerOk)}>{savedMessage}</div> : null}

      <main {...stylex.props(styles.main)}>
        <ProviderSidebar
          providers={providers}
          selectedId={state.selectedProviderId}
          mainRef={config.model?.main}
          liteRef={config.model?.lite}
          onSelect={(providerId) => dispatch({ type: "select", providerId })}
          onAdd={() => setAddProviderOpen(true)}
          onDelete={
            state.selectedProviderId
              ? () => {
                  if (state.selectedProviderId) dispatch({ type: "deleteProvider", providerId: state.selectedProviderId });
                }
              : undefined
          }
        />
        <ProviderDetail
          providerId={state.selectedProviderId ?? ""}
          onAddModel={() => setAddModelOpen(true)}
          provider={selectedProvider}
          models={selectedProvider?.models ?? {}}
          onChange={(provider) => {
            if (state.selectedProviderId) {
              dispatch({ type: "upsertProvider", providerId: state.selectedProviderId, provider });
            }
          }}
        />
      </main>

      {addModelOpen ? (
        <AddModelDialog
          providers={providers}
          defaultProviderId={state.selectedProviderId}
          gatewayModels={gatewayModels}
          onClose={() => setAddModelOpen(false)}
          onCreate={(providerId, modelId, model) => {
            const next = cloneConfig(config);
            const p = next.provider?.[providerId];
            if (p) {
              p.models = { ...(p.models ?? {}), [modelId]: model };
              dispatch({ type: "patchConfig", config: next });
              dispatch({ type: "select", providerId });
            }
            setAddModelOpen(false);
          }}
        />
      ) : null}
      {addProviderOpen ? (
        <AddProviderDialog
          existingIds={Object.keys(providers)}
          onClose={() => setAddProviderOpen(false)}
          onCreate={(providerId, provider) => {
            dispatch({ type: "upsertProvider", providerId, provider });
            setAddProviderOpen(false);
          }}
        />
      ) : null}
      {saveOpen ? (
        <SaveDialog
          scope={state.scope}
          config={config}
          targetPath={fileInfo?.path ?? ""}
          onCancel={() => setSaveOpen(false)}
          onConfirm={onSave}
        />
      ) : null}
    </div>
  );
}

function ModelRoleSelect(props: {
  label: string;
  value: string;
  models: { providerId: string; modelId: string; name?: string; multimodal: boolean }[];
  onChange: (value: string) => void;
}): React.ReactElement {
  const options: SelectOption[] = props.models.map((model) => ({
    value: `${model.providerId}/${model.modelId}`,
    label: model.modelId,
    hint: [model.multimodal ? "👁" : null].filter(Boolean).join(" ") || undefined,
    group: model.providerId,
  }));
  return (
    <div {...stylex.props(styles.roleSelect)}>
      <span {...stylex.props(styles.roleLabel)}>{props.label}</span>
      <Select
        value={props.value}
        onChange={props.onChange}
        options={options}
        placeholder={t("select.notSet")}
        ariaLabel={props.label}
      />
    </div>
  );
}
