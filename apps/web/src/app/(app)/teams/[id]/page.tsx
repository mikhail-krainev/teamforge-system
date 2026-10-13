import { notFound } from 'next/navigation';
import { TeamDetailPage } from '@/features/teams/TeamDetailPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return (
    <div className="page-wide">
      <TeamDetailPage teamId={id} />
    </div>
  );
}
