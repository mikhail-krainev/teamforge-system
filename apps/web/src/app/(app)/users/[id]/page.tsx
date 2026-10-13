import { notFound } from 'next/navigation';
import { PublicProfileView } from '@/features/profile/PublicProfileView';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return (
    <div className="page-wide">
      <PublicProfileView userId={id} />
    </div>
  );
}
