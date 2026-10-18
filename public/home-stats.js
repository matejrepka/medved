const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit",
});

function localDay(value) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = dayFormatter.formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function homeStats({ warnings = [], news = [] } = {}, now = new Date()) {
  const today = localDay(now);
  // Calendar arithmetic keeps seven local days even across a DST change.
  const weekDate = new Date(`${today}T12:00:00Z`);
  weekDate.setUTCDate(weekDate.getUTCDate() - 6);
  const weekStart = weekDate.toISOString().slice(0, 10);
  const count = (items, field, since) => items.filter((item) => {
    const day = localDay(item?.[field]);
    return day && day >= since && day <= today;
  }).length;
  return {
    todaySightings: count(warnings, "reportedAt", today),
    weekSightings: count(warnings, "reportedAt", weekStart),
    todayNews: count(news, "date", today),
  };
}
