/**
 * DSH-Enhance — 浏览器半边。
 *
 * 三块界面：
 *   1. 会话「…」菜单里的「删除对话」（含归档对话），带二次确认。
 *   2. 工作区「…」菜单里的「修改工作区」+ 会话行拖到工作区行，把对话迁移过去。
 *   3. 设置 → 功能增强：三个开关、搜索/抓取的优先-候补链、各平台 key 与模式。
 *
 * 这里刻意不 import 任何 Host 包：配置命名空间与平台表都是字面量，
 * Host 侧同名常量在 lib/chain.js 与 lib/platforms.js。
 */
window.__ModuleLoader__.load({
  id: "dsh-enhance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    /**
     * primitives 属于宿主内部包。它改名或消失时，宁可让界面降级（原生按钮 /
     * 原生下拉 / 只读设置页），也不能让整个客户端模块加载失败——那样会话菜单、
     * 拖拽和设置页会一起消失。
     */
    var prim;
    try {
      prim = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch (error) {
      prim = {};
      try {
        console.warn("[dsh-enhance] 宿主 primitives 不可用，界面已降级", error);
      } catch {
        // 忽略日志失败。
      }
    }
    if (prim === null || typeof prim !== "object") prim = {};
    var h = React.createElement;

    /** 配置命名空间 = profile 条目 id。 */
    var NS = "dsh-enhance";
    /** 文案命名空间。 */
    var L10N = "settings.dshEnhance";

    //#region 平台表
    /**
     * 平台元信息。quota 是设置页里标题后面显示的免费额度，keyUrl 是「获取 key」链接。
     * 与 lib/platforms.js 保持一致；这里不 import Host 包，所以复制一份字面量。
     */
    var PLATFORMS = [
      {
        id: "deepseek",
        label: "DeepSeek 官方",
        quota: "由 DSH 内置「网页搜索」设置管理",
        keyUrl: "https://platform.deepseek.com/api_keys",
        keyRef: "DEEPSEEK_API_KEY",
        managed: true,
        functions: ["search", "fetch"]
      },
      {
        id: "parallel",
        label: "Parallel",
        quota: "每月 5,000 次请求免费",
        keyUrl: "https://platform.parallel.ai/",
        keyRef: "PARALLEL_API_KEY",
        functions: ["search"]
      },
      {
        id: "tavily",
        label: "Tavily",
        quota: "每月 1,000 credits 免费",
        keyUrl: "https://app.tavily.com/home",
        keyRef: "TAVILY_API_KEY",
        functions: ["search", "fetch"]
      },
      {
        id: "firecrawl",
        label: "Firecrawl",
        quota: "每月 1,000 credits 免费",
        keyUrl: "https://www.firecrawl.dev/app/api-keys",
        keyRef: "FIRECRAWL_API_KEY",
        functions: ["search", "fetch"]
      }
    ];
    var PLATFORM_BY_ID = new Map(PLATFORMS.map(function (p) { return [p.id, p]; }));

    /** 某个功能可用的平台。 */
    function platformsFor(fn) {
      return PLATFORMS.filter(function (p) { return p.functions.indexOf(fn) !== -1; });
    }

    /** 链的默认值。 */
    var DEFAULT_SEARCH_CHAIN = "parallel,deepseek";
    var DEFAULT_FETCH_CHAIN = "tavily,firecrawl,deepseek";
    //#endregion

    //#region 文案
    var zh = {
      title: "功能增强",
      enableDelete: "对话删除功能",
      enableDeleteHint: "在对话与归档对话的「…」菜单里显示「删除对话」。",
      enableMove: "工作区修改功能",
      enableMoveHint: "支持把对话拖到别的工作区，以及工作区菜单里的「修改工作区」。",
      enableSearch: "搜索功能替换",
      enableSearchHint: "优先平台不可用时自动换候补平台，搜索与抓取共用这套开关。",
      searchSection: "搜索功能",
      fetchSection: "抓取功能",
      primary: "优先",
      fallbackN: "候补{n}",
      empty: "空",
      recommended: "推荐",
      mode: "模式",
      keySection: "平台密钥",
      keyConfigured: "已配置",
      keyMissing: "未配置",
      getKey: "获取 Key",
      freeQuota: "免费额度",
      save: "保存",
      saving: "保存中…",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      readOnly: "本部署的设置为只读。",
      unavailable: "该插件当前未加载，暂时无法配置。",
      overridden: "已覆盖",
      reset: "恢复默认",
      // 会话菜单
      deleteSession: "删除对话",
      deleteTitle: "删除对话",
      deleteConfirm: "确定永久删除「{name}」吗？会话记录与文件都会被移除，无法恢复。",
      deleteConfirmArchived: "确定永久删除归档对话「{name}」吗？此操作无法恢复。",
      delete: "删除",
      cancel: "取消",
      deleting: "删除中…",
      deleteFailed: "删除失败：{error}",
      deleted: "已删除「{name}」",
      // 工作区迁移
      moveWorkspace: "修改工作区",
      moveTitle: "修改工作区",
      moveDescription: "选择目标工作区后，「{name}」里的全部对话都会迁移过去。",
      moveEmpty: "这个工作区还没有对话。",
      movePickDirectory: "选择其他目录…",
      moveTarget: "目标工作区",
      moveSame: "不能迁移到同一个工作区",
      moveNoTarget: "请先选择目标工作区",
      moving: "迁移中…",
      moveFailed: "迁移失败：{error}",
      moveDone: "已迁移 {count} 个对话到「{title}」",
      movePartial: "已迁移 {count} 个，{failed} 个失败",
      moveOne: "已把「{name}」移动到「{title}」",
      sessions: "{count} 个对话",
      close: "关闭"
    };
    var en = {
      title: "Enhancements",
      enableDelete: "Session deletion",
      enableDeleteHint: "Adds Delete session to the session and archived-session menus.",
      enableMove: "Workspace migration",
      enableMoveHint: "Drag a session onto another workspace, or use Change workspace in the workspace menu.",
      enableSearch: "Search replacement",
      enableSearchHint: "Falls back to the next provider when the preferred one is unusable. Applies to search and fetch.",
      searchSection: "Search",
      fetchSection: "Fetch",
      primary: "Preferred",
      fallbackN: "Fallback {n}",
      empty: "None",
      recommended: "Recommended",
      mode: "Mode",
      keySection: "Provider keys",
      keyConfigured: "Configured",
      keyMissing: "Not configured",
      getKey: "Get key",
      freeQuota: "Free quota",
      save: "Save",
      saving: "Saving…",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      readOnly: "This deployment stores settings read-only.",
      unavailable: "This plugin is not loaded, so it cannot be configured right now.",
      overridden: "Overridden",
      reset: "Reset to default",
      deleteSession: "Delete session",
      deleteTitle: "Delete session",
      deleteConfirm: "Permanently delete \"{name}\"? Its transcript and files are removed; this cannot be undone.",
      deleteConfirmArchived: "Permanently delete the archived session \"{name}\"? This cannot be undone.",
      delete: "Delete",
      cancel: "Cancel",
      deleting: "Deleting…",
      deleteFailed: "Delete failed: {error}",
      deleted: "Deleted \"{name}\"",
      moveWorkspace: "Change workspace",
      moveTitle: "Change workspace",
      moveDescription: "Every session in \"{name}\" moves to the workspace you pick.",
      moveEmpty: "This workspace has no sessions yet.",
      movePickDirectory: "Pick another directory…",
      moveTarget: "Target workspace",
      moveSame: "Pick a different workspace",
      moveNoTarget: "Pick a target workspace first",
      moving: "Moving…",
      moveFailed: "Move failed: {error}",
      moveDone: "Moved {count} sessions to \"{title}\"",
      movePartial: "Moved {count}, {failed} failed",
      moveOne: "Moved \"{name}\" to \"{title}\"",
      sessions: "{count} sessions",
      close: "Close"
    };
    //#endregion

    //#region 工具
    /** 简易格式化：把 {name} 换成参数。 */
    function format(template, params) {
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
      });
    }

    /** 调宿主路由。 */
    function hostCall(path, body) {
      return fetch("/dsh-enhance/" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body === undefined ? {} : body)
      }).then(function (response) {
        return response.json().catch(function () {
          return { ok: false, error: "HTTP " + response.status };
        });
      }).catch(function (error) {
        // 路由没注册（宿主升级后路径变化）时不能让对话框一直转圈。
        return { ok: false, error: "无法连接宿主路由：" + ((error && error.message) || String(error)) };
      });
    }

    /** 读出会话的展示标题。 */
    function titleOf(sessions, sessionId) {
      var row = sessions && sessions.byId ? sessions.byId[sessionId] : undefined;
      var title = row && (row.title || row.displayTitle);
      return typeof title === "string" && title.length > 0 ? title : sessionId;
    }
    //#endregion

    //#region 轻量状态
    /** 统一的告警出口：宿主没接 console 时也不能把功能带崩。 */
    function warn(message, error) {
      try {
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[dsh-enhance] " + message, error);
        }
      } catch {
        // 日志失败忽略。
      }
    }

    /** 一个最小可用的外部 store。 */
    function createStore(initial) {
      var value = initial;
      var listeners = new Set();
      return {
        get: function () { return value; },
        set: function (next) {
          value = next;
          listeners.forEach(function (fn) { fn(); });
        },
        subscribe: function (fn) {
          listeners.add(fn);
          return function () { listeners.delete(fn); };
        }
      };
    }

    /** 从 store 直接取快照（非 hook 场景，例如事件回调）。 */
    function readStore(store) {
      if (typeof store.getSnapshot === "function") return store.getSnapshot();
      return store.get();
    }

    /** 用外部 store 生成 hook。 */
    function useStore(store) {
      var read = function () { return readStore(store); };
      return React.useSyncExternalStore(store.subscribe, read, read);
    }
    //#endregion

    //#region 配置
    /**
     * 配置视图：把 configForms 的 scope 快照投影成「开关 + 链 + 模式」。
     * 表单本身仍走 SettingsFormModel，保证与其它插件设置页同一套暂存/保存语义。
     *
     * Host 侧的 configForms / SettingsFormModel 属于内部实现，接口一旦变化就
     * 直接抛错；这里兜住异常，让设置页退化成只读提示，而不是连累整个客户端插件
     * 加载失败（那样会话菜单和拖拽也会一起消失）。
     */
    function createConfigView(ctx) {
      try {
        return buildConfigView(ctx);
      } catch (error) {
        warn("配置视图不可用，设置页已降级为只读", error);
        return degradedConfigView();
      }
    }

    /** 配置视图构造失败时的只读替身。 */
    function degradedConfigView() {
      var store = createStore({
        shell: { writable: false, dirty: false, saving: false, error: null },
        enableDelete: true,
        enableMove: true,
        enableSearch: true,
        enableFetch: true,
        searchChain: DEFAULT_SEARCH_CHAIN,
        fetchChain: DEFAULT_FETCH_CHAIN,
        secrets: {}
      });
      return {
        store: store,
        actions: {},
        field: function () { return { text: "", error: null }; },
        shell: function () { return { writable: false, dirty: false, saving: false, error: null }; },
        refreshCredential: function () {},
        dispose: function () {}
      };
    }

    function buildConfigView(ctx) {
      var configForms = ctx.get ? ctx.get("configForms") : ctx.configForms;
      if (!configForms || typeof configForms.get !== "function") {
        throw new Error("宿主没有提供 configForms 服务");
      }
      if (!prim || typeof prim.SettingsFormModel !== "function") {
        throw new Error("宿主没有提供 SettingsFormModel");
      }
      var scope = configForms.get(NS);

      /** 链字段的 spec：原样保留逗号与空槽，交给 Host 解析。 */
      function chainSpec(field) {
        return {
          field: field,
          format: function (value) { return typeof value === "string" ? value : ""; },
          parse: function (text) {
            var trimmed = text.trim();
            if (trimmed.length === 0) return { kind: "clear" };
            return { kind: "set", value: text };
          }
        };
      }

      /** 布尔字段的 spec：Switch 只写 "true" / "false"。 */
      function boolSpec(field) {
        return {
          field: field,
          format: function (value) { return value === true ? "true" : value === false ? "false" : ""; },
          parse: function (text) {
            if (text === "true") return { kind: "set", value: true };
            if (text === "false") return { kind: "set", value: false };
            return undefined;
          }
        };
      }

      var SPECS = [
        boolSpec("enableDelete"),
        boolSpec("enableMove"),
        boolSpec("enableSearch"),
        boolSpec("enableFetch"),
        chainSpec("searchChain"),
        chainSpec("fetchChain"),
        { field: "minChars", format: function (v) { return typeof v === "number" ? String(v) : ""; }, parse: numberParser() },
        { field: "maxResults", format: function (v) { return typeof v === "number" ? String(v) : ""; }, parse: numberParser() }
      ];

      var credentials = new Map();
      var form = new prim.SettingsFormModel(
        scope,
        SPECS,
        PLATFORMS.map(function (platform) {
          return {
            field: platform.id + "ApiKey",
            write: function (text) { return writeKey(platform, text); }
          };
        })
      );
      var bound = form.bind(project);
      var unsubscribeScope = scope.subscribe(function () {
        readAllCredentials();
        bound.set(project());
      });
      readAllCredentials();

      function numberParser() {
        return function (text) {
          var value = text.trim();
          if (value.length === 0) return { kind: "clear" };
          var parsed = Number(value);
          return Number.isFinite(parsed) ? { kind: "set", value: parsed } : undefined;
        };
      }

      /** 读某个平台配置字段（优先当前快照）。 */
      function fieldValue(field) {
        var snapshot = scope.getSnapshot();
        var value = snapshot.value ? snapshot.value[field] : undefined;
        return value;
      }

      /** 平台密钥的凭据引用。 */
      function refOf(platform) {
        var declared = fieldValue(platform.id + "KeyEnv");
        return typeof declared === "string" && declared.length > 0 ? declared : platform.keyRef;
      }

      function project() {
        var shell = form.shell();
        var value = {
          shell: shell,
          enableDelete: form.field("enableDelete").text !== "false",
          enableMove: form.field("enableMove").text !== "false",
          enableSearch: form.field("enableSearch").text !== "false",
          enableFetch: form.field("enableFetch").text !== "false",
          searchChain: form.field("searchChain").text,
          fetchChain: form.field("fetchChain").text,
          secrets: {}
        };
        PLATFORMS.forEach(function (platform) {
          var credential = credentials.get(platform.id) || { configured: false, writable: true };
          value.secrets[platform.id] = {
            text: form.field(platform.id + "ApiKey").text,
            configured: credential.configured,
            writable: credential.writable
          };
        });
        return value;
      }

      function readAllCredentials() {
        PLATFORMS.forEach(readCredential);
      }

      function readCredential(platform) {
        var ref = refOf(platform);
        var current = credentials.get(platform.id);
        if (current === undefined || current.ref !== ref) {
          credentials.set(platform.id, { ref: ref, configured: false, writable: true });
          bound.set(project());
        }
        var remote = ctx.get("remote");
        if (!remote || !remote.credentials) return;
        remote.credentials.describe([ref]).then(function (response) {
          if (!response || response.ok !== true) return;
          if (ref !== refOf(platform)) return;
          var view = response.value ? response.value[ref] : undefined;
          var next = {
            ref: ref,
            configured: Boolean(view && view.configured),
            writable: view === undefined || view.writable !== false
          };
          var previous = credentials.get(platform.id);
          if (previous && previous.configured === next.configured && previous.writable === next.writable) return;
          credentials.set(platform.id, next);
          bound.set(project());
        }).catch(function () {});
      }

      function writeKey(platform, text) {
        var remote = ctx.get("remote");
        if (!remote || !remote.credentials) return Promise.resolve(false);
        return remote.credentials.set(refOf(platform), text).then(function () {
          return new Promise(function (resolve) {
            setTimeout(function () {
              readCredential(platform);
              resolve(credentials.get(platform.id) ? credentials.get(platform.id).configured : false);
            }, 0);
          });
        });
      }

      return {
        store: bound,
        actions: form.actions(),
        field: function (field) { return form.field(field); },
        shell: function () { return form.shell(); },
        refreshCredential: function (ref) {
          PLATFORMS.forEach(function (platform) {
            var current = credentials.get(platform.id);
            if (current && current.ref === ref) readCredential(platform);
          });
        },
        dispose: function () {
          unsubscribeScope();
          form.dispose();
        }
      };
    }
    //#endregion

    //#region 会话菜单：删除
    /**
     * 删除请求的共享状态：菜单项只发布目标，overlay 负责确认与执行。
     */
    function createDeleteRequest() {
      var store = createStore(null);
      return {
        store: store,
        open: function (sessionId, displayTitle, archived) {
          store.set({ sessionId: sessionId, title: displayTitle, archived: archived === true });
        },
        close: function () { store.set(null); }
      };
    }

    /** 会话「…」菜单里的删除行。 */
    function makeDeleteMenuItem(ctx, config, request) {
      return function DeleteSessionMenuItem(props) {
        var t = props.t;
        var state = useStore(config.store);
        var menuState = props.useMenuOpenState ? props.useMenuOpenState() : [false, function () {}];
        if (!state.enableDelete) return null;
        var Item = prim.MenuItemButton;
        var icon = typeof prim.IconTrashOutlineRegular === "function" ? h(prim.IconTrashOutlineRegular, { size: 14 }) : undefined;
        var onSelect = function () {
          if (typeof menuState[1] === "function") menuState[1](false);
          request.open(props.sessionId, props.displayTitle || props.sessionId, false);
        };
        if (typeof Item === "function") {
          return h(Item, { danger: true, icon: icon, onSelect: onSelect }, t("deleteSession"));
        }
        return h("button", { type: "button", role: "menuitem", onClick: onSelect }, t("deleteSession"));
      };
    }

    /** 删除确认卡片。 */
    function makeDeleteOverlay(ctx, config, request, toast) {
      return function DeleteSessionOverlay(props) {
        var t = props.t;
        var target = useStore(request.store);
        var featureState = useStore(config.store);
        var sessionsState = props.useSessions ? props.useSessions(function (s) { return s; }) : null;
        var pending = React.useState(false);
        var deleting = pending[0];
        var setDeleting = pending[1];
        var errorState = React.useState(null);
        var error = errorState[0];
        var setError = errorState[1];
        var cardRef = React.useRef(null);
        var cancelRef = React.useRef(null);

        React.useEffect(function () {
          if (target === null) {
            setError(null);
            setDeleting(false);
            return;
          }
          if (cancelRef.current) cancelRef.current.focus();
        }, [target]);

        if (target === null || !featureState.enableDelete) return null;

        var close = function () {
          if (deleting) return;
          request.close();
        };

        var confirm = function () {
          if (deleting) return;
          setDeleting(true);
          setError(null);
          hostCall("delete-session", { sessionId: target.sessionId }).then(function (result) {
            if (result && result.ok === true) {
              request.close();
              toast.show("ok", format(t("deleted"), { name: target.title }));
              refreshSessions(ctx);
              return;
            }
            setError((result && result.error) || "unknown error");
          }).catch(function (reason) {
            setError(reason && reason.message ? reason.message : String(reason));
          }).finally(function () {
            setDeleting(false);
          });
        };

        var title = target.title || (sessionsState ? titleOf(sessionsState, target.sessionId) : target.sessionId);
        return h("div", {
          className: "dse-scrim",
          role: "presentation",
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) close();
          }
        }, h("div", {
          ref: cardRef,
          className: "dse-dialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": t("deleteTitle"),
          tabIndex: -1
        }, [
          h("div", { key: "title", className: "dse-dialog-title" }, t("deleteTitle")),
          h("p", { key: "body", className: "dse-dialog-body" }, format(target.archived ? t("deleteConfirmArchived") : t("deleteConfirm"), { name: title })),
          error === null ? null : h("p", { key: "error", className: "dse-dialog-error" }, format(t("deleteFailed"), { error: error })),
          h("div", { key: "footer", className: "dse-dialog-footer" }, [
            h("button", {
              key: "cancel",
              ref: cancelRef,
              type: "button",
              className: "dse-btn",
              disabled: deleting,
              onClick: close
            }, t("cancel")),
            h("button", {
              key: "confirm",
              type: "button",
              className: "dse-btn dse-btn-danger",
              disabled: deleting,
              onClick: confirm
            }, deleting ? t("deleting") : t("delete"))
          ])
        ]));
      };
    }

    /** 删除成功后刷新客户端会话列表。 */
    function refreshSessions(ctx) {
      var sessions = ctx.get("sessions");
      if (sessions && typeof sessions.refresh === "function") {
        try {
          Promise.resolve(sessions.refresh()).catch(function () {});
        } catch (error) {
          // 刷新失败不影响删除结果。
        }
      }
    }
    //#endregion

    //#region 工作区迁移
    /** 迁移对话框状态。 */
    function createMoveRequest() {
      var store = createStore(null);
      return {
        store: store,
        open: function (workspaceId, title, count) {
          store.set({ workspaceId: workspaceId, title: title, count: count });
        },
        close: function () { store.set(null); }
      };
    }

    /** 迁移对话框：列出现有工作区 + 选择其他目录。 */
    function makeMoveOverlay(ctx, config, request, toast) {
      return function MoveWorkspaceOverlay(props) {
        var t = props.t;
        var target = useStore(request.store);
        var featureState = useStore(config.store);
        var workspaceState = props.useWorkspaces ? props.useWorkspaces(function (s) { return s; }) : null;
        var picked = React.useState(null);
        var selected = picked[0];
        var setSelected = picked[1];
        var busy = React.useState(false);
        var moving = busy[0];
        var setMoving = busy[1];
        var errorState = React.useState(null);
        var error = errorState[0];
        var setError = errorState[1];

        React.useEffect(function () {
          if (target === null) {
            setSelected(null);
            setError(null);
            setMoving(false);
          }
        }, [target]);

        if (target === null || !featureState.enableMove) return null;

        var items = (workspaceState && workspaceState.items) || [];
        var candidates = items.filter(function (item) { return item.workspaceId !== target.workspaceId; });

        var close = function () {
          if (moving) return;
          request.close();
        };

        var run = function (targetWorkspaceId) {
          if (moving) return;
          setMoving(true);
          setError(null);
          hostCall("move-workspace", { sourceWorkspaceId: target.workspaceId, targetWorkspaceId: targetWorkspaceId }).then(function (result) {
            if (result && result.ok === true) {
              request.close();
              var title = result.targetTitle || "";
              if (result.failedCount > 0) {
                toast.show("info", format(t("movePartial"), { count: result.movedCount, failed: result.failedCount }));
              } else {
                toast.show("ok", format(t("moveDone"), { count: result.movedCount, title: title }));
              }
              refreshSessions(ctx);
              return;
            }
            setError((result && result.error) || "unknown error");
          }).catch(function (reason) {
            setError(reason && reason.message ? reason.message : String(reason));
          }).finally(function () {
            setMoving(false);
          });
        };

        var pickDirectory = function () {
          var uiWorkspace = ctx.get("uiWorkspace");
          var workspaces = ctx.get("workspaces");
          if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== "function" || !workspaces) return;
          Promise.resolve(uiWorkspace.pickDirectory()).then(function (path) {
            if (typeof path !== "string" || path.length === 0) return undefined;
            return workspaces.create({ path: path });
          }).then(function (view) {
            if (view === undefined) return;
            run(view.workspaceId);
          }).catch(function (reason) {
            setError(reason && reason.message ? reason.message : String(reason));
          });
        };

        return h("div", {
          className: "dse-scrim",
          role: "presentation",
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) close();
          }
        }, h("div", { className: "dse-dialog", role: "dialog", "aria-modal": "true", "aria-label": t("moveTitle") }, [
          h("div", { key: "title", className: "dse-dialog-title" }, t("moveTitle")),
          h("p", { key: "body", className: "dse-dialog-body" }, format(t("moveDescription"), { name: target.title || target.workspaceId })),
          target.count === 0
            ? h("p", { key: "empty", className: "dse-dialog-body" }, t("moveEmpty"))
            : h("div", { key: "list", className: "dse-list", role: "listbox", "aria-label": t("moveTarget") },
                candidates.map(function (item) {
                  var active = selected === item.workspaceId;
                  return h("button", {
                    key: item.workspaceId,
                    type: "button",
                    role: "option",
                    "aria-selected": active,
                    className: "dse-list-item" + (active ? " is-active" : ""),
                    disabled: moving,
                    onClick: function () { setSelected(item.workspaceId); }
                  }, [
                    h("span", { key: "title", className: "dse-list-title" }, item.title || item.workspaceId),
                    h("span", { key: "count", className: "dse-list-meta" }, format(t("sessions"), { count: item.sessionIds ? item.sessionIds.length : 0 }))
                  ]);
                })
              ),
          error === null ? null : h("p", { key: "error", className: "dse-dialog-error" }, format(t("moveFailed"), { error: error })),
          h("div", { key: "footer", className: "dse-dialog-footer" }, [
            h("button", { key: "pick", type: "button", className: "dse-btn", disabled: moving, onClick: pickDirectory }, t("movePickDirectory")),
            h("button", { key: "cancel", type: "button", className: "dse-btn", disabled: moving, onClick: close }, t("cancel")),
            h("button", {
              key: "go",
              type: "button",
              className: "dse-btn dse-btn-primary",
              disabled: moving || selected === null,
              onClick: function () {
                if (selected === null) {
                  setError(t("moveNoTarget"));
                  return;
                }
                run(selected);
              }
            }, moving ? t("moving") : t("moveTarget"))
          ])
        ]));
      };
    }

    /** 从 DOM 里找出工作区菜单当前对应的行。 */
    function workspaceRowFromPoint(event) {
      var node = event.target;
      while (node && node !== document.body) {
        if (node.getAttribute) {
          var key = node.getAttribute("data-row-key");
          if (typeof key === "string" && key.indexOf("workspace:") === 0) return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    /**
     * 往工作区「…」菜单里插一行「修改工作区」。
     * 菜单由宿主用 portal 渲染，没有插槽，只能观察 DOM 后注入。
     */
    function installWorkspaceMenuInjector(ctx, config, request, t) {
      if (typeof document === "undefined" || typeof MutationObserver === "undefined") return function () {};
      var lastWorkspace = null;
      var injected = new Set();
      var disposed = false;
      var queued = false;

      var remember = function (event) {
        var row = workspaceRowFromPoint(event);
        if (row === null) return;
        var key = row.getAttribute("data-row-key") || "";
        var workspaceId = key.slice("workspace:".length);
        if (workspaceId.length === 0) return;
        var titleNode = row.querySelector(".title") || row.querySelector("[class*='title']");
        var title = titleNode && titleNode.textContent ? titleNode.textContent.trim() : workspaceId;
        lastWorkspace = { workspaceId: workspaceId, title: title };
      };

      var itemClassName = function (reference) {
        return String(reference.className || "")
          .split(/\s+/)
          .filter(function (name) { return name.length > 0 && !/(?:^|[_-])danger(?:$|[_-])/i.test(name); })
          .join(" ");
      };

      var inject = function () {
        queued = false;
        if (disposed) return;
        if (readStore(config.store).enableMove !== true) return;
        if (lastWorkspace === null) return;
        var menus = document.querySelectorAll('[role="menu"]');
        for (var m = 0; m < menus.length; m += 1) {
          var menu = menus[m];
          if (menu.querySelector('[data-dse-move-workspace="true"]')) continue;
          var items = Array.prototype.slice.call(menu.querySelectorAll('button[role="menuitem"]'));
          if (items.length === 0) continue;
          // 工作区菜单只有「重命名」「删除工作区」两行；用危险项当锚点，插在它前面。
          var dangerItem = null;
          for (var i = 0; i < items.length; i += 1) {
            if (/(?:^|[_-])danger(?:$|[_-])/i.test(String(items[i].className || ""))) {
              dangerItem = items[i];
              break;
            }
          }
          if (dangerItem === null) continue;
          var wrap = dangerItem.parentElement;
          if (wrap === null) continue;
          var reference = items[0] === dangerItem ? dangerItem : items[0];

          var holder = document.createElement("div");
          holder.className = wrap.className;
          var button = document.createElement("button");
          button.type = "button";
          button.setAttribute("role", "menuitem");
          button.dataset.dseMoveWorkspace = "true";
          button.className = itemClassName(reference);
          var iconSpan = document.createElement("span");
          iconSpan.setAttribute("aria-hidden", "true");
          var iconRef = reference.querySelector("span");
          if (iconRef && iconRef.className) iconSpan.className = iconRef.className;
          iconSpan.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5h11"/><path d="M4.5 2.5v4"/><path d="M11.5 2.5v4"/><path d="M2.5 4.5v8a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-8"/><path d="M6.5 9.5l1.6 1.6 2.6-2.8"/></svg>';
          var textSpan = document.createElement("span");
          var labelRef = reference.querySelectorAll("span")[1];
          if (labelRef && labelRef.className) textSpan.className = labelRef.className;
          textSpan.textContent = t("moveWorkspace");
          button.append(iconSpan, textSpan);

          var target = lastWorkspace;
          var count = countWorkspaceSessions(ctx, target.workspaceId);
          if (count === 0) {
            button.disabled = true;
            button.style.opacity = "0.5";
            button.style.cursor = "not-allowed";
          }
          button.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            request.open(target.workspaceId, target.title, countWorkspaceSessions(ctx, target.workspaceId));
          });
          holder.append(button);
          wrap.parentNode.insertBefore(holder, wrap);
          injected.add(holder);
        }
      };

      /** DOM 结构随宿主版本变化时，注入失败只记一条告警，不中断观察器。 */
      var runInject = function () {
        try {
          inject();
        } catch (error) {
          warn("工作区菜单注入失败，宿主菜单结构可能已变化", error);
        }
      };

      var schedule = function () {
        if (queued || disposed) return;
        queued = true;
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(runInject);
        else setTimeout(runInject, 16);
      };

      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i += 1) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j += 1) {
            var node = added[j];
            if (node.nodeType === 1) {
              if (node.matches && node.matches('[role="menu"]')) return schedule();
              if (node.querySelector && node.querySelector('[role="menu"]')) return schedule();
            }
          }
        }
      });

      document.addEventListener("pointerdown", remember, true);
      document.addEventListener("click", remember, true);
      observer.observe(document.body, { childList: true, subtree: true });

      return function () {
        disposed = true;
        document.removeEventListener("pointerdown", remember, true);
        document.removeEventListener("click", remember, true);
        observer.disconnect();
        injected.forEach(function (node) { if (node.parentElement) node.parentElement.removeChild(node); });
        injected.clear();
        for (var leftover of document.querySelectorAll('[data-dse-move-workspace="true"]')) {
          if (leftover.parentElement) leftover.parentElement.remove();
        }
      };
    }

    /** 工作区里的对话数。 */
    function countWorkspaceSessions(ctx, workspaceId) {
      var workspaces = ctx.get("workspaces");
      var snapshot = workspaces && workspaces.list && workspaces.list.getSnapshot ? workspaces.list.getSnapshot() : null;
      var items = (snapshot && snapshot.items) || [];
      for (var i = 0; i < items.length; i += 1) {
        if (items[i].workspaceId === workspaceId) return (items[i].sessionIds || []).length;
      }
      return 0;
    }

    /**
     * 拖动会话到别的工作区：宿主的行拖拽已经把 session id 写进 text/plain，
     * 这里只在落点是一个「不属于该会话」的工作区行时接管。
     */
    function installSessionDrag(ctx, config, toast, t) {
      if (typeof document === "undefined") return function () {};
      var enabled = function () { return readStore(config.store).enableMove === true; };

      var sessionOfDrag = function (event) {
        var raw = "";
        try {
          raw = event.dataTransfer ? event.dataTransfer.getData("text/plain") : "";
        } catch (error) {
          raw = "";
        }
        if (typeof raw !== "string" || raw.length === 0) return null;
        var sessions = ctx.get("sessions");
        var snapshot = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
        if (snapshot && snapshot.byId && snapshot.byId[raw]) return raw;
        return null;
      };

      var targetWorkspace = function (event) {
        var row = workspaceRowFromPoint(event);
        if (row === null) return null;
        var key = row.getAttribute("data-row-key") || "";
        var workspaceId = key.slice("workspace:".length);
        return workspaceId.length > 0 ? workspaceId : null;
      };

      var workspaceOfSession = function (sessionId) {
        var workspaces = ctx.get("workspaces");
        var snapshot = workspaces && workspaces.list && workspaces.list.getSnapshot ? workspaces.list.getSnapshot() : null;
        var items = (snapshot && snapshot.items) || [];
        for (var i = 0; i < items.length; i += 1) {
          if ((items[i].sessionIds || []).indexOf(sessionId) !== -1) return items[i];
        }
        return null;
      };

      var onDragOver = function (event) {
        if (!enabled()) return;
        if (targetWorkspace(event) === null) return;
        event.preventDefault();
        try {
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        } catch (error) {
          // 忽略只读 dataTransfer。
        }
      };

      var onDropInner = function (event) {
        if (!enabled()) return;
        var workspaceId = targetWorkspace(event);
        if (workspaceId === null) return;
        var sessionId = sessionOfDrag(event);
        if (sessionId === null) return;
        var source = workspaceOfSession(sessionId);
        if (source !== null && source.workspaceId === workspaceId) return;
        event.preventDefault();
        event.stopPropagation();
        var sessions = ctx.get("sessions");
        var snapshot = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
        var name = titleOf(snapshot, sessionId);
        hostCall("move-session", { sessionId: sessionId, targetWorkspaceId: workspaceId }).then(function (result) {
          if (result && result.ok === true) {
            toast.show("ok", format(t("moveOne"), { name: name, title: result.targetTitle || workspaceId }));
            refreshSessions(ctx);
            return;
          }
          toast.show("err", format(t("moveFailed"), { error: (result && result.error) || "unknown error" }));
        }).catch(function (reason) {
          toast.show("err", format(t("moveFailed"), { error: reason && reason.message ? reason.message : String(reason) }));
        });
      };

      /** 拖放依赖宿主行结构，抛错时只提示失败。 */
      var onDrop = function (event) {
        try {
          onDropInner(event);
        } catch (error) {
          warn("拖拽迁移失败，宿主侧边栏结构可能已变化", error);
        }
      };

      document.addEventListener("dragover", onDragOver, true);
      document.addEventListener("drop", onDrop, true);
      return function () {
        document.removeEventListener("dragover", onDragOver, true);
        document.removeEventListener("drop", onDrop, true);
      };
    }
    //#endregion

    //#region 设置页
    /** 每条链固定三个槽位：优先、候补 1、候补 2。 */
    var SLOTS = ["primary", "fallback1", "fallback2"];

    /**
     * 每个槽位的推荐平台。参考 dsh-webenhance 的额度分工：
     * 搜索只花 Parallel 的额度，抓取先花 Tavily、再 Firecrawl 兜底，
     * 官方接口在两边都作为最后一道保险。
     */
    var RECOMMEND = {
      search: ["parallel", "deepseek", "deepseek"],
      fetch: ["tavily", "firecrawl", "deepseek"]
    };

    /** 把链字符串拆成固定三行（多余的丢弃，缺的补空）。 */
    function chainRows(value, fallback) {
      var raw = typeof value === "string" && value.length > 0 ? value : fallback;
      var rows = raw.split(",").slice(0, SLOTS.length);
      while (rows.length < SLOTS.length) rows.push("");
      return rows;
    }

    /** 把行数组写回链字符串。 */
    function chainValue(rows) {
      return rows.join(",");
    }

    /** 弹出式选择按钮：横向的按钮 + 浮层菜单。 */
    function PopupSelect(props) {
      var t = props.t;
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var current = props.value;
      var label = t("empty");
      for (var i = 0; i < props.options.length; i += 1) {
        if (props.options[i].value === current) label = props.options[i].label;
      }
      var items = props.options.map(function (option) {
        return { id: option.value, label: option.label };
      });
      var Menu = prim.Menu;
      if (typeof Menu !== "function") {
        // 宿主换了菜单实现时的降级：用原生下拉，宽度与行为都不变。
        return h("select", {
          className: "dse-select dse-select-native" + (current === "" ? " is-empty" : ""),
          value: current,
          disabled: props.disabled,
          title: label,
          onChange: function (event) { props.onChange(event.target.value); }
        }, props.options.map(function (option) {
          return h("option", { key: option.value, value: option.value }, option.label);
        }));
      }
      return h(Menu, {
        open: open,
        onClose: function () { setOpen(false); },
        items: items,
        selectedId: current === "" ? undefined : current,
        onSelect: function (id) {
          setOpen(false);
          props.onChange(id);
        },
        portal: true,
        align: "start",
        side: "bottom",
        anchor: h("button", {
          type: "button",
          className: "dse-select" + (current === "" ? " is-empty" : ""),
          "aria-haspopup": "menu",
          "aria-expanded": open,
          disabled: props.disabled,
          onClick: function () { setOpen(!open); },
          title: label
        }, [
          h("span", { key: "label", className: "dse-select-label" }, label),
          h("span", { key: "caret", className: "dse-select-caret", "aria-hidden": "true" }, "▾")
        ])
      });
    }

    /**
     * 一个链槽位：优先 / 候补 1 / 候补 2 + 平台选择。
     * 一行三个槽位平分宽度，因此不再有删除按钮。
     */
    function ChainRow(props) {
      var t = props.t;
      var index = props.index;
      var fn = props.fn;
      // 推荐只按「这个槽位」判定，与平台自身无关：同一平台在别的槽位不标推荐。
      var recommendedId = (RECOMMEND[fn] || [])[index];
      var options = [{ value: "", label: t("empty") }].concat(props.options.map(function (platform) {
        return { value: platform.id, label: platform.label + (platform.id === recommendedId ? " · " + t("recommended") : "") };
      }));
      return h("div", { className: "dse-chain-row" }, [
        h("span", {
          key: "badge",
          className: "dse-chain-badge" + (index === 0 ? " is-primary" : "")
        }, index === 0 ? t("primary") : format(t("fallbackN"), { n: index })),
        h(PopupSelect, {
          key: "select",
          t: t,
          value: props.value,
          options: options,
          disabled: props.disabled,
          onChange: props.onChange
        })
      ]);
    }

    /** 功能开关行。 */
    function ToggleRow(props) {
      var t = props.t;
      var Switch = prim.Switch;
      return h("div", { className: "dse-toggle" }, [
        h("div", { key: "text", className: "dse-toggle-text" }, [
          h("span", { key: "label", className: "dse-toggle-label" }, props.label),
          h("span", { key: "hint", className: "dse-toggle-hint" }, props.hint)
        ]),
        typeof Switch === "function"
          ? h(Switch, {
              key: "switch",
              checked: props.checked,
              label: props.label,
              disabled: props.disabled,
              onChange: function (next) { props.onChange(next); }
            })
          : h("input", {
              key: "switch",
              type: "checkbox",
              checked: props.checked,
              disabled: props.disabled,
              onChange: function (event) { props.onChange(event.target.checked); }
            })
      ]);
    }

    /** 平台密钥栏：标题 + 免费额度 + 获取 key 链接 + 输入框。 */
    function KeyRow(props) {
      var t = props.t;
      var platform = props.platform;
      var secret = props.secret;
      return h("div", { className: "dse-key" }, [
        h("div", { key: "head", className: "dse-key-head" }, [
          h("span", { key: "label", className: "dse-key-label" }, platform.label),
          h("span", { key: "quota", className: "dse-key-quota" }, t("freeQuota") + "：" + platform.quota),
          h("a", {
            key: "link",
            className: "dse-key-link",
            href: platform.keyUrl,
            target: "_blank",
            rel: "noreferrer noopener"
          }, t("getKey") + " ↗")
        ]),
        h("div", { key: "body", className: "dse-key-body" }, [
          h("input", {
            key: "input",
            className: "dse-input",
            type: "password",
            autoComplete: "new-password",
            placeholder: secret.configured ? t("keyConfigured") : t("keyMissing"),
            value: secret.text,
            disabled: props.disabled || secret.writable === false,
            onChange: function (event) { props.onEdit(event.target.value); }
          }),
          h("span", {
            key: "state",
            className: "dse-key-state" + (secret.configured ? " is-set" : "")
          }, secret.configured ? t("keyConfigured") : t("keyMissing"))
        ])
      ]);
    }

    /** 设置页主体。 */
    function makeSettingsSection(ctx, config) {
      return function EnhanceSettingsSection(props) {
        var t = props.t;
        var state = useStore(config.store);
        var shell = state.shell;
        var disabled = !shell.writable;

        var edit = function (field, value) {
          // 表单动作由宿主经槽位 props 注入；拿不到时保持页面可读而不是抛错。
          if (typeof props.edit !== "function") return;
          props.edit(field, typeof value === "string" ? value : String(value));
        };

        var rowsOf = function (fn, field, fallback) {
          return chainRows(state[field], fallback);
        };

        var setRow = function (fn, field, fallback, index, value) {
          var rows = rowsOf(fn, field, fallback);
          rows[index] = value;
          edit(field, chainValue(rows));
        };

        /** 当前链里出现的平台（去重，用于 key 配置栏）。 */
        var activePlatforms = function (fn, field, fallback) {
          var seen = new Set();
          var result = [];
          rowsOf(fn, field, fallback).forEach(function (id) {
            if (id.length === 0 || seen.has(id)) return;
            var platform = PLATFORM_BY_ID.get(id);
            if (platform === undefined || platform.functions.indexOf(fn) === -1) return;
            seen.add(id);
            result.push(platform);
          });
          return result;
        };

        var searchRows = rowsOf("search", "searchChain", DEFAULT_SEARCH_CHAIN);
        var fetchRows = rowsOf("fetch", "fetchChain", DEFAULT_FETCH_CHAIN);
        var searchPlatforms = activePlatforms("search", "searchChain", DEFAULT_SEARCH_CHAIN);
        var fetchPlatforms = activePlatforms("fetch", "fetchChain", DEFAULT_FETCH_CHAIN);

        /**
         * 密钥栏覆盖的平台：链里出现的 + 所有第三方平台，保证任何一家都有配置入口。
         * 宿主托管凭据的平台（DeepSeek 官方）跳过。
         */
        var keyPlatforms = [];
        var keySeen = new Set();
        searchPlatforms.concat(fetchPlatforms, PLATFORMS).forEach(function (platform) {
          if (platform.managed === true) return;
          if (keySeen.has(platform.id)) return;
          keySeen.add(platform.id);
          keyPlatforms.push(platform);
        });

        return h("div", { className: "dse-page" }, [
          h(ToggleRow, {
            key: "delete",
            t: t,
            label: t("enableDelete"),
            hint: t("enableDeleteHint"),
            checked: state.enableDelete,
            disabled: disabled,
            onChange: function (next) { edit("enableDelete", next ? "true" : "false"); }
          }),
          h(ToggleRow, {
            key: "move",
            t: t,
            label: t("enableMove"),
            hint: t("enableMoveHint"),
            checked: state.enableMove,
            disabled: disabled,
            onChange: function (next) { edit("enableMove", next ? "true" : "false"); }
          }),
          h(ToggleRow, {
            key: "search",
            t: t,
            label: t("enableSearch"),
            hint: t("enableSearchHint"),
            checked: state.enableSearch,
            disabled: disabled,
            onChange: function (next) {
              edit("enableSearch", next ? "true" : "false");
              edit("enableFetch", next ? "true" : "false");
            }
          }),

          state.enableSearch
            ? h("div", { key: "search-config", className: "dse-panel" }, [
                h("div", { key: "head", className: "dse-panel-head" }, [
                  h("span", { key: "title", className: "dse-panel-title" }, t("searchSection"))
                ]),
                h("div", { key: "rows", className: "dse-chain" },
                  searchRows.map(function (value, index) {
                    return h(ChainRow, {
                      key: "search-" + index,
                      t: t,
                      fn: "search",
                      index: index,
                      value: value,
                      options: platformsFor("search"),
                      disabled: disabled,
                      onChange: function (next) { setRow("search", "searchChain", DEFAULT_SEARCH_CHAIN, index, next); }
                    });
                  })
                )
              ])
            : null,

          state.enableSearch
            ? h("div", { key: "fetch-config", className: "dse-panel" }, [
                h("div", { key: "head", className: "dse-panel-head" }, [
                  h("span", { key: "title", className: "dse-panel-title" }, t("fetchSection"))
                ]),
                h("div", { key: "rows", className: "dse-chain" },
                  fetchRows.map(function (value, index) {
                    return h(ChainRow, {
                      key: "fetch-" + index,
                      t: t,
                      fn: "fetch",
                      index: index,
                      value: value,
                      options: platformsFor("fetch"),
                      disabled: disabled,
                      onChange: function (next) { setRow("fetch", "fetchChain", DEFAULT_FETCH_CHAIN, index, next); }
                    });
                  })
                )
              ])
            : null,

          state.enableSearch && keyPlatforms.length > 0
            ? h("div", { key: "keys", className: "dse-panel" }, [
                h("div", { key: "head", className: "dse-panel-head" }, [
                  h("span", { key: "title", className: "dse-panel-title" }, t("keySection"))
                ]),
                keyPlatforms.map(function (platform) {
                  return h(KeyRow, {
                    key: platform.id,
                    t: t,
                    platform: platform,
                    secret: state.secrets[platform.id] || { text: "", configured: false, writable: true },
                    disabled: disabled,
                    onEdit: function (text) { props.edit(platform.id + "ApiKey", text); }
                  });
                })
              ])
            : null,

          h("div", { key: "footer", className: "dse-footer" }, [
            shell.failed ? h("span", { key: "failed", className: "dse-error" }, t("saveFailed")) : null,
            shell.invalid ? h("span", { key: "invalid", className: "dse-error" }, t("saveFailed")) : null,
            h("button", {
              key: "discard",
              type: "button",
              className: "dse-btn",
              disabled: disabled || (!shell.dirty && !shell.failed),
              onClick: props.discard
            }, t("reset")),
            h("button", {
              key: "save",
              type: "button",
              className: "dse-btn dse-btn-primary",
              disabled: disabled || !shell.dirty || shell.invalid || shell.saving,
              onClick: props.save
            }, shell.saving ? t("saving") : t("save"))
          ])
        ]);
      };
    }
    //#endregion

    //#region 样式
    var CSS = [
      ".dse-scrim{position:fixed;inset:0;z-index:140;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);}",
      ".dse-dialog{width:min(460px,92vw);max-height:82vh;overflow:auto;padding:18px 18px 14px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#1b1f27);border:0.5px solid var(--dsw-alias-border-l2,#3a4150);color:var(--dsw-alias-label-primary,#eceff4);box-shadow:0 18px 50px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:10px;}",
      ".dse-dialog-title{font-size:15px;font-weight:600;}",
      ".dse-dialog-body{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9aa3b2);}",
      ".dse-dialog-error{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5534b);}",
      ".dse-dialog-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:4px;}",
      ".dse-btn{height:30px;padding:0 14px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2,#3a4150);background:transparent;color:var(--dsw-alias-label-primary,#eceff4);font-size:13px;cursor:pointer;}",
      ".dse-btn:disabled{opacity:.5;cursor:default;}",
      ".dse-btn-primary{border-color:var(--dsw-alias-state-success-primary,#3fb68b);color:var(--dsw-alias-state-success-primary,#3fb68b);}",
      ".dse-btn-danger{border-color:var(--dsw-alias-state-error-primary,#e5534b);color:var(--dsw-alias-state-error-primary,#e5534b);}",
      ".dse-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto;}",
      ".dse-list-item{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2,#3a4150);background:transparent;color:inherit;font-size:13px;cursor:pointer;text-align:left;}",
      ".dse-list-item.is-active{border-color:var(--dsw-alias-state-success-primary,#3fb68b);}",
      ".dse-list-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".dse-list-meta{font-size:12px;color:var(--dsw-alias-label-tertiary,#6f7787);flex:none;}",
      ".dse-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:150;padding:8px 14px;border-radius:9px;background:var(--dsw-alias-bg-overlay,#1b1f27);border:0.5px solid var(--dsw-alias-border-l2,#3a4150);color:var(--dsw-alias-label-primary,#eceff4);font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:80vw;}",
      ".dse-toast-ok{border-color:var(--dsw-alias-state-success-primary,#3fb68b);color:var(--dsw-alias-state-success-primary,#3fb68b);}",
      ".dse-toast-err{border-color:var(--dsw-alias-state-error-primary,#e5534b);color:var(--dsw-alias-state-error-primary,#e5534b);}",
      ".dse-page{display:flex;flex-direction:column;gap:14px;}",
      ".dse-toggle{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:0.5px solid var(--dsw-alias-border-l2,#3a4150);}",
      ".dse-toggle-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}",
      ".dse-toggle-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#eceff4);}",
      ".dse-toggle-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#6f7787);}",
      ".dse-panel{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:10px;border:0.5px solid var(--dsw-alias-border-l2,#3a4150);}",
      ".dse-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}",
      ".dse-panel-title{font-size:13px;font-weight:600;}",
      ".dse-panel-mode{display:flex;align-items:center;gap:8px;}",
      ".dse-mode-label{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);}",
      ".dse-chain{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));align-items:center;gap:10px;}",
      ".dse-chain-row{display:flex;align-items:center;gap:5px;min-width:0;}",
      ".dse-chain-row>:not(.dse-chain-badge){flex:1 1 0;min-width:0;}",
      ".dse-chain-badge{flex:none;width:38px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa3b2);}",
      ".dse-chain-badge.is-primary{color:var(--dsw-alias-state-success-primary,#3fb68b);}",
      ".dse-select{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 8px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2,#3a4150);background:transparent;color:var(--dsw-alias-label-primary,#eceff4);font-size:12px;cursor:pointer;width:100%;box-sizing:border-box;}",
      ".dse-select.is-empty{color:var(--dsw-alias-label-tertiary,#6f7787);}",
      ".dse-select-label{flex:1;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".dse-select-caret{font-size:10px;opacity:.7;}",
      ".dse-key{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-top:0.5px solid var(--dsw-alias-border-l2,#3a4150);}",
      ".dse-key:first-of-type{border-top:none;}",
      ".dse-key-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
      ".dse-key-label{font-size:13px;font-weight:500;}",
      ".dse-key-quota{font-size:12px;color:var(--dsw-alias-label-tertiary,#6f7787);}",
      ".dse-key-link{margin-left:auto;font-size:12px;color:var(--dsw-alias-state-info-primary,#4b9cf5);text-decoration:none;}",
      ".dse-key-body{display:flex;align-items:center;gap:8px;}",
      ".dse-input{flex:1;height:30px;padding:0 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2,#3a4150);background:transparent;color:var(--dsw-alias-label-primary,#eceff4);font-size:13px;}",
      ".dse-key-state{flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary,#6f7787);}",
      ".dse-key-state.is-set{color:var(--dsw-alias-state-success-primary,#3fb68b);}",
      ".dse-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:6px;}",
      // 原生 select 降级时去掉系统箭头外框，保持与自绘按钮同一套外观。
      ".dse-select-native{appearance:none;-webkit-appearance:none;}",
      // 面板被挤窄时三个槽位改为整行，避免选择框被压到不可读。
      "@media (max-width:560px){.dse-chain{grid-template-columns:minmax(0,1fr);}}",
      ".dse-error{margin-right:auto;font-size:12px;color:var(--dsw-alias-state-error-primary,#e5534b);}"
    ].join("");
    //#endregion

    //#region 装配
    /**
     * 只声明真正必需的槽位与文案服务。configForms / remote 这类宿主内部实现
     * 改为按需 ctx.get 并判空，避免宿主升级改名后整个客户端插件不加载。
     */
    var inject = ["slots", "locale"];

    /** 挂载全部界面。 */
    function apply(ctx) {
      var t = ctx.locale.bind(L10N);
      ctx.effect(function () {
        return ctx.locale.register(L10N, { zh: zh, en: en });
      }, "dsh-enhance: dictionaries");

      ctx.effect(function () {
        var style = document.createElement("style");
        style.setAttribute("data-dsh-enhance", "styles");
        style.textContent = CSS;
        document.head.append(style);
        return function () { style.remove(); };
      }, "dsh-enhance: styles");

      /**
       * 槽位与注入点由宿主提供；某一个不存在或签名变了，只丢那一块界面，
       * 其余功能照常挂载。
       */
      var safeMount = function (label, fn) {
        try {
          fn();
        } catch (error) {
          warn("挂载失败：" + label, error);
        }
      };

      var config = createConfigView(ctx);
      ctx.effect(function () { return function () { config.dispose(); }; }, "dsh-enhance: config view");

      var toastStore = createStore(null);
      var toastTimer = null;
      var toast = {
        show: function (kind, text) {
          if (toastTimer !== null) {
            clearTimeout(toastTimer);
            toastTimer = null;
          }
          toastStore.set({ kind: kind, text: text });
          toastTimer = setTimeout(function () {
            toastTimer = null;
            toastStore.set(null);
          }, 2600);
        }
      };

      var deleteRequest = createDeleteRequest();
      var moveRequest = createMoveRequest();

      // 会话菜单里的删除行。
      safeMount("session menu", function () {
        ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
          return ctx.slots.register({
            name: "sidebar.workspaces.session.menu.item",
            id: "dsh-enhance.delete-session",
            order: 500,
            locale: L10N,
            inject: function () { return { t: t }; }
          }, makeDeleteMenuItem(ctx, config, deleteRequest));
        });
      });

      // 删除确认与迁移对话框。
      safeMount("delete overlay", function () {
        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({
            name: "shell.overlay",
            id: "dsh-enhance.delete-session",
            locale: L10N,
            inject: function () { return { t: t }; }
          }, makeDeleteOverlay(ctx, config, deleteRequest, toast));
        });
      });
      safeMount("move overlay", function () {
        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({
            name: "shell.overlay",
            id: "dsh-enhance.move-workspace",
            locale: L10N,
            inject: function () { return { t: t }; }
          }, makeMoveOverlay(ctx, config, moveRequest, toast));
        });
      });
      safeMount("toast overlay", function () {
        ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({
            name: "shell.overlay",
            id: "dsh-enhance.toast",
            order: 200
          }, function EnhanceToast() {
            var current = useStore(toastStore);
            if (current === null) return null;
            return h("div", { className: "dse-toast dse-toast-" + current.kind, role: "status" }, current.text);
          });
        });
      });

      // 工作区菜单注入 + 拖拽迁移。
      ctx.effect(function () {
        return installWorkspaceMenuInjector(ctx, config, moveRequest, t);
      }, "dsh-enhance: workspace menu");
      ctx.effect(function () {
        return installSessionDrag(ctx, config, toast, t);
      }, "dsh-enhance: session drag");

      // 设置页：仅在 Host 服务本插件命名空间期间出现。
      safeMount("settings page", function () {
        var configForms = ctx.get ? ctx.get("configForms") : ctx.configForms;
        if (!configForms || typeof configForms.whileServed !== "function") {
          warn("宿主没有提供 configForms.whileServed，设置页不可用");
          return;
        }
        ctx.effect(function () {
          return configForms.whileServed([NS], function () {
            return ctx.slots.inject("settings.section", function () {
              return ctx.slots.register({
                name: "settings.section",
                id: NS,
                order: 46,
                label: function () { return t("title"); },
                locale: L10N,
                inject: function () {
                  return Object.assign({ t: t }, config.actions);
                }
              }, makeSettingsSection(ctx, config));
            });
          });
        }, "dsh-enhance: settings page");
      });

      ctx.effect(function () {
        var remote = ctx.get("remote");
        if (!remote || typeof remote.$on !== "function") return function () {};
        return remote.$on("credentials/reference-updated", function (ref) {
          config.refreshCredential(ref);
        });
      }, "dsh-enhance: credential invalidations");
    }
    //#endregion

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
