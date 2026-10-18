import { notFound } from 'next/navigation';
import { GithubPage } from '@/features/github/GithubPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Param = string | string[] | undefined;
const first = (value: Param): string | undefined => (Array.isArray(value) ? value[0] : value);

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ installation?: Param; error?: Param }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  return (
    <div className="page-wide">
      <GithubPage teamId={id} installation={first(query.installation)} error={first(query.error)} />
    </div>
  );
}
