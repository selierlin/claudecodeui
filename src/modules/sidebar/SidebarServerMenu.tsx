import { Preferences } from '@capacitor/preferences';
import { Check, ChevronDown, LogOut, Server, Settings, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM } from '@/shared/utils';
import { ActionMenu, Button, Dialog, DialogContent, DialogTitle, type ActionMenuItem } from '@/shared/ui';

const PICKER_URL_KEY = 'cloudcli.pickerUrl';
const SERVERS_KEY = 'cloudcli.servers';
const SERVER_NAME_KEY = 'cloudcli.serverName';

type WebCachePlugin = {
  clear: () => Promise<void>;
};

type ServerSessionPlugin = {
  showPicker: () => Promise<void>;
  switchToServer: (options: { url: string }) => Promise<void>;
};

/** 选择页（mobile/www/picker.js）持久化到原生存储的已保存服务器条目。 */
type SavedServer = {
  name?: string;
  url: string;
};

type CapacitorWindow = {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    registerPlugin?: (name: string) => unknown;
  };
};

type SidebarServerMenuProps = {
  serverName: string | null;
  onShowSettings: () => void;
};

export default function SidebarServerMenu({ serverName, onShowSettings }: SidebarServerMenuProps) {
  const { t } = useTranslation(['sidebar', 'auth']);
  const { user, logout } = useAuth();
  const [pickerUrl, setPickerUrl] = useState<string | null>(null);
  // 已保存服务器列表，用于在服务器名称菜单里直接切换（而非先回到选择页）。
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isLogoutDialogOpen, setIsLogoutDialogOpen] = useState(false);
  const [isClearCacheDialogOpen, setIsClearCacheDialogOpen] = useState(false);

  const capacitor = (window as unknown as CapacitorWindow).Capacitor;
  const isNativeShell = Boolean(capacitor?.isNativePlatform?.());
  const menuLabel = serverName ?? t('app.title');
  // 当前 webview 所在的服务器 origin，用于在快速切换列表中标记当前服务器。
  const currentServerUrl = typeof window !== 'undefined' ? window.location.origin : '';

  useEffect(() => {
    if (!isNativeShell) {
      return undefined;
    }

    let disposed = false;
    void Preferences.get({ key: PICKER_URL_KEY })
      .then((result) => {
        if (!disposed && result.value) {
          setPickerUrl(result.value);
        }
      })
      .catch(() => {
        // 无法读取服务器选择页地址时，仅隐藏返回入口。
      });

    void Preferences.get({ key: SERVERS_KEY })
      .then((result) => {
        if (disposed || !result.value) {
          return;
        }
        try {
          const parsed: unknown = JSON.parse(result.value);
          if (Array.isArray(parsed)) {
            setServers(
              parsed.filter(
                (item): item is SavedServer =>
                  typeof item === 'object' && item !== null && typeof item.url === 'string',
              ),
            );
          }
        } catch {
          // 服务器列表数据损坏时忽略，仅不展示快速切换。
        }
      })
      .catch(() => {
        // 无法读取服务器列表时，仅不展示快速切换。
      });

    return () => {
      disposed = true;
    };
  }, [isNativeShell]);

  const returnToServerList = () => {
    const serverSession = capacitor?.registerPlugin?.('ServerSession') as ServerSessionPlugin | undefined;
    if (serverSession) {
      void serverSession.showPicker().catch(() => {
        if (pickerUrl) {
          window.location.href = pickerUrl;
        }
      });
      return;
    }

    if (pickerUrl) {
      window.location.href = pickerUrl;
    }
  };

  /**
   * 直接切换到指定服务器：先写入目标服务器名称（splash 与侧栏标题读取自
   * 原生存储），再调用原生 ServerSession.switchToServer 复用/加载对应 WebView。
   */
  const switchServer = async (server: SavedServer) => {
    const serverSession = capacitor?.registerPlugin?.('ServerSession') as ServerSessionPlugin | undefined;
    if (!serverSession) {
      return;
    }
    try {
      await Preferences.set({ key: SERVER_NAME_KEY, value: server.name || server.url });
    } catch {
      // 写入名称失败不阻断切换，仅目标页标题可能不准确。
    }
    try {
      await serverSession.switchToServer({ url: server.url });
    } catch {
      // 原生切换失败时停留在当前服务器。
    }
  };

  const clearCache = async () => {
    try {
      const webCache = capacitor?.registerPlugin?.('WebCache') as WebCachePlugin | undefined;
      if (!webCache) {
        throw new Error('WebCache plugin is unavailable');
      }

      await webCache.clear();
      window.location.reload();
    } catch (error) {
      console.error('[Server menu] Failed to clear app cache:', error);
      window.alert(t('actions.clearCacheFailed'));
    }
  };

  const requestLogout = () => {
    setIsMobileMenuOpen(false);
    setIsLogoutDialogOpen(true);
  };

  const menuItems: ActionMenuItem[] = [
    {
      key: 'settings',
      label: t('actions.settings'),
      icon: Settings,
      onSelect: onShowSettings,
    },
  ];

  // 原生壳内直接列出已保存服务器，点击即可切换，无需先回到选择页。
  if (isNativeShell && pickerUrl && servers.length > 0) {
    servers.forEach((server, index) => {
      const isCurrent = server.url === currentServerUrl;
      menuItems.push({
        key: `server-${server.url}`,
        label: server.name || server.url,
        description: server.url,
        icon: isCurrent ? Check : Server,
        onSelect: isCurrent ? () => undefined : () => void switchServer(server),
        showDividerBefore: index === 0,
      });
    });
  }

  if (pickerUrl) {
    menuItems.push({
      key: 'server-list',
      label: t('actions.backToServerList'),
      icon: Server,
      onSelect: returnToServerList,
      showDividerBefore: true,
    });
  }

  if (isNativeShell) {
    menuItems.push({
      key: 'clear-cache',
      label: t('actions.clearCache'),
      icon: Trash2,
      onSelect: () => setIsClearCacheDialogOpen(true),
      isDanger: true,
      showDividerBefore: !pickerUrl,
    });
  }

  if (!IS_PLATFORM && user) {
    menuItems.push({
      key: 'logout',
      label: t('logout.button', { ns: 'auth' }),
      icon: LogOut,
      onSelect: requestLogout,
      isDanger: true,
      showDividerBefore: true,
    });
  }

  const runMobileItem = (item: ActionMenuItem) => {
    setIsMobileMenuOpen(false);
    item.onSelect();
  };

  const menuHeader = (
    <div className="border-b border-border px-3 py-2.5">
      <p className="truncate text-sm font-medium text-foreground" title={menuLabel}>{menuLabel}</p>
      {!IS_PLATFORM && user && <p className="truncate text-xs text-muted-foreground">{user.username}</p>}
    </div>
  );

  return (
    <>
      <ActionMenu
        label={menuLabel}
        items={menuItems}
        ariaLabel={menuLabel}
        align="left"
        variant="ghost"
        size="sm"
        className="hidden min-w-0 max-w-[168px] md:inline-flex"
        triggerClassName="h-7 min-w-0 max-w-full gap-1 px-1.5 text-left text-sm font-bold tracking-tight text-foreground [&>span]:truncate"
        menuClassName="min-w-[236px]"
        portal
        header={menuHeader}
      />

      <Dialog open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
        <button
          type="button"
          className="flex min-w-0 max-w-[172px] items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-bold tracking-tight text-foreground transition-colors active:bg-accent md:hidden"
          onClick={() => setIsMobileMenuOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={isMobileMenuOpen}
        >
          <span className="truncate">{menuLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        </button>
        <DialogContent
          wrapperClassName="md:hidden"
          animationClassName="animate-bottom-sheet-content-show motion-reduce:animate-none"
          className="bottom-0 left-0 top-auto max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border-x-0 border-b-0 px-4 pb-safe-area-inset-bottom pt-3"
        >
          <DialogTitle>{menuLabel}</DialogTitle>
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />
          <div className="mb-4 px-1">
            <p className="truncate text-base font-semibold text-foreground" title={menuLabel}>{menuLabel}</p>
            {!IS_PLATFORM && user && <p className="truncate text-sm text-muted-foreground">{user.username}</p>}
          </div>
          <div className="space-y-2">
            {menuItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`flex min-h-12 w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors active:bg-muted ${
                    item.isDanger
                      ? 'border-destructive/20 bg-destructive/5 text-destructive'
                      : 'border-border bg-muted/35 text-foreground'
                  }`}
                  onClick={() => runMobileItem(item)}
                >
                  {Icon && <Icon className="h-5 w-5 flex-shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{item.label}</span>
                    {item.description && (
                      <span className="block truncate text-xs text-muted-foreground">{item.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <Button
            type="button"
            variant="ghost"
            className="mb-3 mt-2 h-11 w-full text-muted-foreground"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            {t('actions.cancel')}
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={isLogoutDialogOpen} onOpenChange={setIsLogoutDialogOpen}>
        <DialogContent className="max-w-sm p-5">
          <DialogTitle>{t('logout.title', { ns: 'auth' })}</DialogTitle>
          <h2 className="text-base font-semibold text-foreground">{t('logout.title', { ns: 'auth' })}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('logout.confirm', { ns: 'auth' })}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setIsLogoutDialogOpen(false)}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setIsLogoutDialogOpen(false);
                logout();
              }}
            >
              {t('logout.button', { ns: 'auth' })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isClearCacheDialogOpen} onOpenChange={setIsClearCacheDialogOpen}>
        <DialogContent className="max-w-sm p-5">
          <DialogTitle>{t('actions.clearCache')}</DialogTitle>
          <h2 className="text-base font-semibold text-foreground">{t('actions.clearCache')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('actions.clearCacheConfirm')}</p>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setIsClearCacheDialogOpen(false)}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setIsClearCacheDialogOpen(false);
                void clearCache();
              }}
            >
              {t('actions.clearCache')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
