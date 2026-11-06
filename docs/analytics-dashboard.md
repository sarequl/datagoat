# Analytics dashboard

The website pages: Overview, Realtime, Visitors, Goals, Funnels and Revenue, plus the public
dashboard behind a share link. The top bar holds the website switcher, **Overview**, **Realtime**
(with the number of visitors online), **Visitors** and **Settings**, *Search or jump to…* (⌘K /
Ctrl K, which lists every page) and the account menu. Goals, Funnels, Revenue and the Growth pages
open from the Overview's cards and lead back to it. Every view is a URL: the period,
granularity, comparison, chart metric and filters are query parameters, so you can bookmark or send
any view.

## All websites

*All websites* (website switcher or account menu, `/app/websites`) lists every website you can open with its visitors,
revenue and live visitors and a visitors trend for the last 24 hours, 7 days or 30 days. Drag a
card, or use its *Move up* / *Move down* buttons, to change the order; it is saved to your account
(`PUT /api/v1/admin/account/website-order`) and the website switcher uses it too.

## Overview

- **Toolbar.** The period (with previous and next arrows), *Compare*, *Filter* and **N online now**,
  which opens the live map (shortcut `M`).
- **KPI row.** Six headline tiles in one card with the main chart: visitors, revenue, conversion
  (or the #1 KPI goal), revenue per visitor, bounce rate and session time, each with the change
  against the previous period of the same length (the previous calendar month for "Last month";
  with *Compare* on, the previous value). Bounce rate counts a fall as good news. Hovering
  Visitors shows new and returning visitors. *More metrics* in the chart toolbar shows the rest:
  payments, sessions, pageviews and, when available, MRR and ROAS. Without revenue (a share link
  that hides it) the row shows visitors, pageviews, sessions, bounce rate and session time.
- **MRR and ROAS.** When payment providers report subscriptions, an **MRR** tile shows the current
  monthly recurring revenue of active and past-due subscriptions (right after Visitors when the
  website's headline revenue metric is MRR, Settings → Attribution & revenue). With Meta Ads
  connected, a **ROAS** tile shows return on ad spend for the period, with spend and revenue.
- **#1 KPI.** When a goal is set as the website's #1 KPI (Goals → a goal → *Set as #1 KPI*, or
  website settings), its tile shows converting visitors and their change in the headline row, and
  every breakdown card can switch its third column from revenue to that goal.
- **Main chart.** Visitors as a line, revenue as bars in the website's KPI colour scheme, with
  refunded amounts greyed out on top of each bar (timeseries field `refunds`). Choose
  hourly, daily, weekly or monthly granularity (what fits the period), and **Compare** to draw the
  previous period as a dashed line and faded bars. Click a KPI tile for a single-metric trend chart
  (conversion rate, revenue per visitor, bounce rate, session time, sessions, pageviews, payments)
  with the previous period dashed; click Visitors for new vs returning. Click it again, or
  *← Visitors / Revenue*, to go back.
- **Markers.** Notes 📝, GitHub commits and 𝕏 mentions appear under the chart (toggle each kind;
  narrow commits to a type such as `feat:` or `fix:`).
  Click a point to pin its numbers (handy for screenshots) with *Add note here* and *View this
  day/week/month*. Click a marker to read, edit or
  delete notes. Keyboard: focus the chart, move with ←/→ (Home/End), Enter for actions, Esc to close.
- **Breakdowns.** Source (channel, referrer, campaign by UTM source/medium/campaign/term/content,
  `ref`, `source`, `via`; plus **Keyword** with Google Search Console clicks, impressions and
  estimated revenue when it is connected, narrowed by a page filter, and **Ads** with each Meta
  campaign's visitors, revenue, spend and ROAS when Meta Ads is connected; clicking a campaign
  filters on its `utm_campaign`), Pages (page, entry page, exit page, exit link, hostname), Location (map,
  country, region, city), System (browser, OS, device) and Goals. Every row shows visitors, revenue
  and payments (exit links: visitors and clicks); clicking a row filters the whole dashboard. The
  Channel tab shows each channel's share of visitors as a donut; clicking a channel (in the donut
  or the list) filters on it and switches to Referrer, so you see the sources inside it.
  *Details* lists up to 1,000 rows with search, sorted by visitors, revenue (clicks for exit links)
  or name.
- **Visitor activity.** A weekday × hour heatmap of visitors or pageviews in the website timezone
  (for periods longer than 41 days, the last 41 days).
- **Hub sections.** Below the breakdowns, signed in:
  - *Conversions*: a funnel (choose which one when there are several; *Open* goes to its page),
    the goals card and the visitor activity heatmap.
  - *Live and revenue*: revenue, MRR, customers and ad return for the period with a revenue trend,
    and a small live map with the latest visitors.
  - *Growth*: X and Reddit mentions, Search Console keywords, AI crawlers and bots, and Meta Ads.

  A feature that is not set up shows a setup card in its place (for example *Connect Search
  Console*, which starts the Google sign-in right there). *Hide this card* hides it in this
  browser; *Add a card* brings hidden cards back. Cards load their data when they scroll into view.
- **New websites.** With no visitors in the period, a banner links to the install guide.

## Period selector

Now (last 30 minutes, minute buckets, refreshes every minute), Today, Yesterday, Last 24 hours,
Last 7 / 30 days, and under *More periods*: Last 3 / 6 / 12 months, Month to date, Last month,
Year to date, All time, plus a custom range. Pin the periods you use (★); pins are remembered per
website in this browser. The arrows step back and forward by the period's length. Shortcuts (DataFast's):
`N` now, `T` today, `Y` yesterday, `D` last 24 hours, `W` last 7 days, `3` last 30 days, plus `Q`
last 3 months, `L` last 12 months and `A` all time.

## Filters and segments

*Filter* opens the builder: pick a dimension (channel, referrer, UTM and `ref`/`source`/`via`
parameters, page, entry page, hostname, country, region, city, browser, OS, device, visit count,
goal), an operator (is, is not, contains, does not contain; at least / at most for visit count) and
one or more values (comma-separated, any of them matches). Filters combine. Click a chip to edit
it, ✕ to remove it. Save the current combination as a **segment**; saved segments are listed at
the top of the builder and apply in one click.

## Realtime

The live visitor count, the list of people on the site now (location, page, source, device, visit
number, customer badge), the event log (click a visitor to see only their events) and recent
payments. The map shows each visitor as a dot coloured by **purchase likelihood** (blue cold → red
likely to buy; predictions need 1,000 visitors and 10 attributed payments). Switch between the
**3D globe** and the **2D map**, pick a style (Outdoors, Dark, Light, Satellite), turn auto-rotation
on or off, go fullscreen, and filter by country, device or browser from the panel. **Replay** plays
the last 8 hours in 15-minute steps.

The globe uses [cobe](https://github.com/shuding/cobe) (MIT) and WebGL; browsers without WebGL get
the 2D map. Maps are drawn locally from Natural Earth shapes ([world-atlas](https://github.com/topojson/world-atlas),
ISC) with d3-geo (ISC): no map tiles are downloaded from third parties, so "Satellite" is a colour
style, not imagery.

## Visitors

Search by name, email, user id or visitor id; show customers only or visitors who completed a goal.
Dashboard filters that the visitors API can match exactly (country, device, referrer, UTM, page,
goal, visit count…) apply; others are listed as not applied. A **profile** shows identity
(location, device, browser and OS versions, viewport, first-touch parameters), activity, the purchase
prediction (or lifetime revenue for customers and profile data from `identify`), goals, payments, a
GitHub-style activity grid (orange = goal or payment days; click a day to jump to it) and the
journey timeline grouped by day with each day's source. Sessions from Google search show the
queries that most likely brought the visitor ("Likely searched: “pricing tool” 62%"): Search
Console's queries for that landing page within three days of the visit, by share of clicks (needs
the Search Console integration).

## Goals

Goal completions over time (toggle lines), and per goal: completions, visitors, conversion rate and
revenue. Click a goal for its **custom properties** (expand one to see its values), to rename it for
display, pick a colour, add a description or hide it from charts, and for quick actions: visitor
journeys, create a funnel, filter the dashboard, set as #1 KPI.

## Funnels

*New funnel*: a name and 2 to 8 steps. A step is a page visit (equals, starts with, ends with,
contains, does not equal, does not contain, or wildcard `*`, optionally on one hostname) or a goal
(completed or not completed). Results show visitors per step, conversion from the first step,
drop-off from the previous step and revenue per step for the selected period and filters.

## Revenue

Revenue, new revenue, renewals, refunds, payments and customers; attribution coverage by method
(checkout metadata, payment link, returning customer, email match, Payment API, unattributed);
revenue by channel and by source (click to filter); lifetime value by first channel; path to
purchase (average days, sessions and pageviews before buying, and the most common channel
sequences); and the payments list with each payment's attribution source, with tabs for
unattributed payments, refunds and renewals.

## Public dashboard

When the owner enables the share link (Settings → Share link), `/share/<token>` shows the overview
read-only to anyone with the link, without signing in: KPIs, chart, breakdowns, goals and heatmap.
Revenue appears only when public revenue is enabled. Visitors, notes, segments and the live map are
not shared.

## Accessibility and phones

Everything works with the keyboard (tabs with arrow keys, dialogs trap focus and close with Esc,
the chart is a keyboard widget with an equivalent data table for screen readers), text meets WCAG
AA contrast in both themes, and every page fits a 390 px wide screen without horizontal scrolling (on phones the top bar's links
and the Settings menu become a scrolling row).
