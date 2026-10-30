import { notFound } from 'next/navigation';
import { SeatCandidatesPage } from '@/features/recommendations/SeatCandidatesPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({
  params,
}: {
  params: Promise<{ id: string; seatId: string }>;
}) {
  const { id, seatId } = await params;
  if (!UUID.test(id) || !UUID.test(seatId)) notFound();
  return (
    <div className="page-wide">
      <SeatCandidatesPage teamId={id} seatId={seatId} />
    </div>
  );
}
