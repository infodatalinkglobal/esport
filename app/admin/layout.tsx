/**
 * The admin dashboard's layout (MODULE 4).
 *
 * A thin server shell: metadata plus the client-side gate (login + tabs +
 * tournament picker + shared state). Pages render inside the gate only after
 * the organizer's secret has been verified, so no admin page ever mounts
 * without a session — and none of them ever touches the secret's storage
 * directly (they read it from the context).
 */

import type { Metadata, Viewport } from 'next';
import { AdminGate } from '@/components/admin/AdminGate';
import { AdminProvider } from '@/components/admin/admin-context';

/** Keeps the dashboard out of search engines: it is a private tool. */
export const metadata: Metadata = {
  title: 'Admin',
  description: 'Organizer dashboard for the DLS Tournament platform.',
  robots: { index: false, follow: false },
};

/** The dashboard is a light app inside a dark site — match the browser chrome. */
export const viewport: Viewport = {
  themeColor: '#f1f5f9',
};

/**
 * @param props.children The admin page (/admin, /admin/players, …).
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-light min-h-screen bg-slate-100 text-slate-900">
      <AdminProvider>
        <AdminGate>{children}</AdminGate>
      </AdminProvider>
    </div>
  );
}
