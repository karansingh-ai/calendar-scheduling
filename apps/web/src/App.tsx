import type { ReactNode } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { isAdmin, useAuth } from "./auth";
import { AppShell } from "./components/AppShell";
import { Loading } from "./components/ui";
import { AuditPage, OrgPage, UsersPage } from "./pages/app/Admin";
import { AvailabilityPage } from "./pages/app/Availability";
import { BookingDetailPage, BookingsPage } from "./pages/app/Bookings";
import { CalendarsPage } from "./pages/app/Calendars";
import { EventTypeEditorPage, EventTypesPage } from "./pages/app/EventTypes";
import { SettingsPage } from "./pages/app/Settings";
import { TeamsPage } from "./pages/app/Teams";
import { InvitePage, LoginPage, SetupPage } from "./pages/auth/AuthPages";
import { BookingPage, ManageBookingPage, ProfilePage } from "./pages/public/PublicPages";

function Home() {
  const { status } = useAuth();
  if (!status) return <Loading />;
  if (status.setupRequired) return <Navigate to="/setup" replace />;
  return <Navigate to={status.user ? "/app" : "/login"} replace />;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (!isAdmin(status?.user)) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/setup", element: <SetupPage /> },
  { path: "/invite/:token", element: <InvitePage /> },
  {
    path: "/app",
    element: <AppShell />,
    children: [
      { index: true, element: <BookingsPage /> },
      { path: "bookings/:id", element: <BookingDetailPage /> },
      { path: "event-types", element: <EventTypesPage /> },
      { path: "event-types/new", element: <EventTypeEditorPage /> },
      { path: "event-types/:id", element: <EventTypeEditorPage /> },
      { path: "availability", element: <AvailabilityPage /> },
      { path: "calendars", element: <CalendarsPage /> },
      { path: "teams", element: <TeamsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "admin/users", element: <AdminOnly><UsersPage /></AdminOnly> },
      { path: "admin/audit", element: <AdminOnly><AuditPage /></AdminOnly> },
      { path: "admin/org", element: <AdminOnly><OrgPage /></AdminOnly> },
      { path: "*", element: <Navigate to="/app" replace /> },
    ],
  },
  { path: "/booking/:id", element: <ManageBookingPage /> },
  { path: "/team/:teamSlug", element: <ProfilePage team /> },
  { path: "/team/:teamSlug/:slug", element: <BookingPage team /> },
  { path: "/:username", element: <ProfilePage /> },
  { path: "/:username/:slug", element: <BookingPage /> },
]);

export function App() {
  return <RouterProvider router={router} />;
}
