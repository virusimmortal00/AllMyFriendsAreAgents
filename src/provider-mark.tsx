import { providerDisplayName, providerLogoUrl } from "../shared/model-presentation";

export function ProviderMark({
  authorId,
  accessProviderId,
  compact = false,
}: {
  authorId?: string;
  accessProviderId?: string;
  compact?: boolean;
}) {
  const authorName = providerDisplayName(authorId);
  const accessName = providerDisplayName(accessProviderId);
  const authorLogo = providerLogoUrl(authorId);
  const accessLogo = providerLogoUrl(accessProviderId);
  const relayed = Boolean(authorId && accessProviderId && authorId !== accessProviderId && authorName !== accessName);
  const title = relayed ? `${authorName} model, accessed through ${accessName}` : `${authorName} model`;
  const initials = authorName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  return (
    <span className={`provider-mark${compact ? " provider-mark--compact" : ""}`} title={title} aria-label={title}>
      <span className="provider-mark__fallback" aria-hidden="true">{initials || "AI"}</span>
      {authorLogo ? <img className="provider-mark__logo" src={authorLogo} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
      {relayed && accessLogo ? (
        <span className="provider-mark__access" title={`Accessed through ${accessName}`}>
          <img src={accessLogo} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />
        </span>
      ) : null}
    </span>
  );
}
