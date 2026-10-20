import { notFound } from 'next/navigation';
import { parseOrdinal } from '@/features/route/model';
import { StagePage } from '@/features/route/StagePage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  const ordinal = parseOrdinal(n);
  if (!UUID.test(id) || ordinal === null) notFound();
  return (
    <div className="page-wide">
      <StagePage teamId={id} ordinal={ordinal} />
    </div>
  );
}
