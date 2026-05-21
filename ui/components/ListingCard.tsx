import type { ListingSummary } from "../types";
import { formatGlm, truncateAddress } from "../format";

interface Props {
  listing: ListingSummary;
}

export function ListingCard({ listing }: Props) {
  return (
    <div className="listing">
      <div className="head">
        <div>
          <div className="action">{truncateAddress(listing.entityKey)}</div>
          <div className="meta">seller {truncateAddress(listing.owner)}</div>
        </div>
        <div>
          <div className="price">{formatGlm(listing.priceWei)}</div>
          <div className="sales">
            {listing.sales} {listing.sales === 1 ? "sale" : "sales"} · earned{" "}
            {formatGlm(listing.totalEarnedWei)}
          </div>
        </div>
      </div>
      <div className="tags">
        {listing.tags.slice(0, 6).map((t) => (
          <span key={`${t.key}:${t.value}`} className="tag muted">
            {t.key}: {String(t.value)}
          </span>
        ))}
      </div>
    </div>
  );
}
