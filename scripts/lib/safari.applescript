-- 通过 Apple Events 驱动用户真实的 Safari，复用其已登录的会话。
--
-- 为什么不用 Playwright：它的 webkit 是独立打包的 WebKit，和 macOS 上真正的
-- Safari 是两回事，读不到用户登录态；safaridriver 虽然能驱动真 Safari，但要 sudo
-- 改系统配置，而且会亮起 navigator.webdriver 标志 —— 等于主动告诉站点这是自动化。
--
-- 所有参数都从 argv 传入，不走 osascript -e，彻底避开字符串转义问题。
-- 前提：Safari → 设置 → 开发 → 勾选「允许来自 Apple Events 的 JavaScript」。

on run argv
	set action to item 1 of argv

	if action is "list" then
		set out to ""
		tell application "Safari"
			repeat with w from 1 to (count of windows)
				repeat with t from 1 to (count of tabs of window w)
					set u to URL of tab t of window w
					set n to name of tab t of window w
					set out to out & (w as text) & (ASCII character 31) & (t as text) & (ASCII character 31) & n & (ASCII character 31) & u & (ASCII character 10)
				end repeat
			end repeat
		end tell
		return out

	else if action is "open" then
		set theURL to item 2 of argv
		tell application "Safari"
			tell window 1
				set newTab to make new tab with properties {URL:theURL}
				set current tab to newTab
			end tell
			delay 0.3
			-- 按 URL 反查下标，比"假定新标签在最后"可靠。
			-- ⚠️ 必须从后往前找。新标签页总在最后，倒着扫先撞上的才是刚开的那个；
			-- 正着扫的话，用户自己已经开着同一个 URL 时（比如登录后停在 zhipin.com/tianjin/），
			-- 返回的是用户那个标签页的下标 —— 之后所有导航都落在用户的标签页里，
			-- 结束时 closeTab 还会把它关掉，等于动了用户的标签页（项目红线）。
			set n to count of tabs of window 1
			repeat with t from n to 1 by -1
				if (URL of tab t of window 1) is theURL then return (t as text)
			end repeat
			return (n as text)
		end tell

	else if action is "close" then
		set idx to (item 2 of argv) as integer
		tell application "Safari" to tell window 1 to close tab idx
		return "ok"

	else if action is "js" then
		set src to item 2 of argv
		set idx to (item 3 of argv) as integer
		tell application "Safari" to return (do JavaScript src in tab idx of window 1)

	end if

	return "unknown action: " & action
end run
