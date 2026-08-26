import { useMemo, useState } from 'react';
import { companyFundamentalsDataset } from '../data/companyFundamentals';
import { companyReportEvents } from '../data/companyReportCalendar';
import styles from './CompanyReportCalendar.module.css';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function beijingToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function monthKey(year: number, monthIndex: number) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function moveMonth(value: string, offset: number) {
  const [year, month] = value.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + offset, 1));
  return monthKey(next.getUTCFullYear(), next.getUTCMonth());
}

function calendarDates(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const monthIndex = monthNumber - 1;
  const firstWeekday = (new Date(Date.UTC(year, monthIndex, 1)).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  return Array.from({ length: cells }, (_, index) => {
    const day = index - firstWeekday + 1;
    if (day < 1 || day > daysInMonth) return undefined;
    return `${month}-${String(day).padStart(2, '0')}`;
  });
}

function displayDate(value: string) {
  const [, month, day] = value.split('-');
  return `${Number(month)} 月 ${Number(day)} 日`;
}

export default function CompanyReportCalendar() {
  const today = beijingToday();
  const initialMonth = today.slice(0, 7);
  const [selectedMonth, setSelectedMonth] = useState(initialMonth);
  const companyById = useMemo(
    () => new Map(companyFundamentalsDataset.companies.map((company) => [company.id, company])),
    [],
  );
  const eventsByDate = useMemo(() => {
    const grouped = new Map<string, typeof companyReportEvents>();
    companyReportEvents.forEach((event) => {
      grouped.set(event.publishedAt, [...(grouped.get(event.publishedAt) ?? []), event]);
    });
    return grouped;
  }, []);
  const monthEvents = companyReportEvents.filter(
    (event) => event.publishedAt.startsWith(selectedMonth),
  );
  const [year, month] = selectedMonth.split('-').map(Number);

  return (
    <section className={styles.calendarSection} aria-label="财报日历">
      <header className={styles.calendarToolbar}>
        <div>
          <strong>{year} 年 {month} 月</strong>
          <span>{monthEvents.length} 项官方披露或确认日程</span>
        </div>
        <div className={styles.monthControls}>
          <button
            type="button"
            aria-label="上个月"
            title="上个月"
            onClick={() => setSelectedMonth((current) => moveMonth(current, -1))}
          >
            ‹
          </button>
          <button
            type="button"
            className={selectedMonth === initialMonth ? styles.currentMonthActive : ''}
            onClick={() => setSelectedMonth(initialMonth)}
          >
            本月
          </button>
          <button
            type="button"
            aria-label="下个月"
            title="下个月"
            onClick={() => setSelectedMonth((current) => moveMonth(current, 1))}
          >
            ›
          </button>
        </div>
      </header>

      <div className={styles.calendarGrid} role="grid" aria-label={`${year} 年 ${month} 月财报日历`}>
        {WEEKDAYS.map((weekday) => (
          <div key={weekday} className={styles.weekday} role="columnheader">{weekday}</div>
        ))}
        {calendarDates(selectedMonth).map((date, index) => {
          const events = date ? eventsByDate.get(date) ?? [] : [];
          return (
            <div
              key={date ?? `empty-${index}`}
              className={`${styles.dayCell} ${date === today ? styles.today : ''} ${!date ? styles.emptyDay : ''}`}
              role="gridcell"
              aria-label={date ? `${displayDate(date)}，${events.length} 项` : undefined}
            >
              {date && <span className={styles.dayNumber}>{Number(date.slice(-2))}</span>}
              <div className={styles.dayEvents}>
                {events.map((event) => {
                  const company = companyById.get(event.companyId);
                  return (
                    <a
                      key={`${event.companyId}-${event.period}-${event.status}`}
                      className={event.status === 'scheduled' ? styles.scheduledEvent : styles.reportedEvent}
                      href={event.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      title={`${company?.name ?? event.companyId} · ${event.period} · ${event.status === 'scheduled' ? '已确认' : '已披露'}`}
                    >
                      {company?.name ?? event.companyId}
                    </a>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.agenda}>
        <header>
          <strong>当月事项</strong>
          <span>日期均为正式披露或公告确认日期</span>
        </header>
        {monthEvents.length > 0 ? monthEvents.map((event) => {
          const company = companyById.get(event.companyId);
          return (
            <a
              key={`${event.companyId}-${event.period}-${event.status}`}
              className={styles.agendaItem}
              href={event.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              <time dateTime={event.publishedAt}>{displayDate(event.publishedAt)}</time>
              <strong>{company?.name ?? event.companyId}</strong>
              <span>{event.period}</span>
              <em className={event.status === 'scheduled' ? styles.scheduledStatus : styles.reportedStatus}>
                {event.status === 'scheduled' ? '已确认' : '已披露'}
              </em>
              <small>{event.sourceLabel ?? '官方公告'}</small>
            </a>
          );
        }) : (
          <p className={styles.emptyAgenda}>本月暂无已录入的官方事项</p>
        )}
      </div>

      <p className={styles.calendarNote}>
        * 日历只收录已披露报告和公司、监管机构或交易所正式确认的日期；第三方预测日期不作为确定日程展示。
      </p>
    </section>
  );
}
