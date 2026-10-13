import type { ReactNode } from 'react';
import { ConsentGate } from '@/features/auth/ConsentGate';

export default function AppLayout({ children }: { children: ReactNode }) {
  return <ConsentGate>{children}</ConsentGate>;
}
