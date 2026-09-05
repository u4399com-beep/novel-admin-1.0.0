import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';

// Server-side only SKIP_AUTH: only effective in development mode.
// Unlike NEXT_PUBLIC_* vars, this is NOT exposed to the client bundle.
const SKIP_AUTH = process.env.NODE_ENV === 'development' && process.env.SKIP_AUTH === 'true';
if (SKIP_AUTH) {
  console.warn('[ADMIN] SKIP_AUTH is enabled — authentication bypassed. Only use in local development!');
}

export const metadata = {
  title: '管理后台 - 小说阁',
  description: '小说阁管理后台',
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!SKIP_AUTH) {
    const session = await getServerSession(authOptions);
    if (!session) {
      redirect('/login');
    }
  }

  return <>{children}</>;
}
