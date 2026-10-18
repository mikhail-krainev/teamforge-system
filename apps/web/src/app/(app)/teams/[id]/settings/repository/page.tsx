import { notFound, redirect } from 'next/navigation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALLATION = /^[1-9]\d{0,14}$/;
const ERROR_CODE = /^[a-z_]{1,40}$/;

type Param = string | string[] | undefined;
const first = (value: Param): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * The address the API sends the browser to after GitHub (`/teams/{id}/settings/repository?installation=`
 * or `?error=`, architecture 7.1): the same screen as `/teams/{id}/github`, carrying the checked parameters on.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ installation?: Param; error?: Param }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  const installation = first(query.installation);
  const error = first(query.error);
  const next = new URLSearchParams();
  if (installation && INSTALLATION.test(installation)) next.set('installation', installation);
  if (error && ERROR_CODE.test(error)) next.set('error', error);
  const suffix = next.size > 0 ? `?${next.toString()}` : '';
  redirect(`/teams/${id}/github${suffix}`);
}
