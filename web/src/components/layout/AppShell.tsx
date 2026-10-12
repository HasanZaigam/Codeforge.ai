import type { ReactNode } from "react";
import { NavLink, useMatch, useNavigate } from "react-router-dom";
import { FolderGit2Icon, LogOutIcon, MonitorIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import { useAuth } from "../../auth/AuthContext.js";
import { useTheme, type ThemePreference } from "../../lib/theme.js";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The entire navigation surface: a brand mark, two links, and the signed-in user — see
 * /docs/UI_ARCHITECTURE.md "Screen structure". Deliberately not a large nav system.
 *
 * Built on shadcn's Sidebar: a collapsible left rail on desktop, an off-canvas sheet opened from the
 * top bar on mobile. Exactly one of the two renders at a time, so nav links/buttons keep stable,
 * unduplicated accessible names at every viewport size (existing tests and screen readers rely on it).
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:hidden">
            <SidebarTrigger />
            <span className="font-heading text-sm font-semibold">CodeForge.ai</span>
          </header>
          <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function AppSidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  const onHome = useMatch({ path: "/", end: true });
  const onProject = useMatch("/projects/*");
  const onTask = useMatch("/tasks/*");
  const onProjects = Boolean(onHome || onProject || onTask);
  const onSettings = useMatch("/settings") !== null;

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  const initials =
    user?.name
      ?.trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?";

  const closeMobile = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<NavLink to="/" onClick={closeMobile} />}>
              <span
                className="flex size-8 items-center justify-center rounded-lg bg-primary font-mono text-xs font-bold text-primary-foreground"
                aria-hidden="true"
              >
                {"</>"}
              </span>
              <span className="font-heading text-base font-semibold">CodeForge.ai</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={onProjects}
                  tooltip="Projects"
                  render={<NavLink to="/" end onClick={closeMobile} />}
                >
                  <FolderGit2Icon />
                  <span>Projects</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={onSettings}
                  tooltip="Settings"
                  render={<NavLink to="/settings" onClick={closeMobile} />}
                >
                  <SettingsIcon />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <ThemeSwitcher />
        {user && (
          <div className="flex items-center gap-2 rounded-lg p-1 group-data-[collapsible=icon]:flex-col">
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initials}</AvatarFallback>
            </Avatar>
            <div className="grid min-w-0 flex-1 text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Log out" title="Log out" onClick={handleLogout}>
              <LogOutIcon />
            </Button>
          </div>
        )}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof SunIcon }[] = [
  { value: "light", label: "Light theme", icon: SunIcon },
  { value: "dark", label: "Dark theme", icon: MoonIcon },
  { value: "system", label: "System theme", icon: MonitorIcon },
];

function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex gap-1 rounded-full bg-sidebar-accent/60 p-1 group-data-[collapsible=icon]:hidden"
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className="flex h-7 flex-1 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground aria-checked:bg-background aria-checked:text-foreground aria-checked:shadow-sm [&_svg]:size-3.5"
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}
