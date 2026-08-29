# CSTracker Chat Inspector

This Tampermonkey script adds a chat analysis panel to CSTracker.gg player profiles. Server admins and players use it to filter chat logs, match regular expressions, and export message data without manual scrolling.

<table border="0">
  <tr>
    <td align="center" valign="middle">
      <img src="https://raw.githubusercontent.com/tomini/CSTracker-Chat-Inspector/main/images/chat_log.png" alt="Chat log" height="320">
    </td>
    <td align="center" valign="middle">
      <img src="https://raw.githubusercontent.com/tomini/CSTracker-Chat-Inspector/main/images/export_config.png" alt="Export configuration" height="320">
    </td>
  </tr>
</table>

### Feature breakdown

* **Search and regular expressions:** A text input filters chat messages. A toggle box enables standard Regex pattern matching.
* **Filtering and highlighting:** Matched strings appear in amber. Enabling "Filter Only Matches" hides messages that do not contain the query.
* **Data export:** Users can export filtered logs to TXT, MD, or CSV formats. Checkboxes toggle the inclusion of Date, Map, Round, and Time metadata.
* **Clipboard copy:** Hovering over a message renders a `COPY` button. The match header contains a `COPY MATCH` button to duplicate a specific game's entire log.
* **Navigation shortcut:** A "JUMP TO CHAT" button bypasses profile statistics. Users can disable this in the Tampermonkey extension menu.
* **Query statistics:** A counter displays the raw number of matching messages and the percentage they represent against the user's total chat history.
* **Navigation controls:** Up and down arrow buttons appear next to the match counter once a query executes. Clicking these buttons shifts the viewport directly to the previous or next matching message in the log history.
* **Dynamic pagination bypass:** If CSTracker is actively paginating chat history, a "FETCH ALL PAGES" button will appear. Clicking it sequentially requests and injects all older chat history pages into the current view, allowing users to search and export a player's complete chat record in one pass. If the site is not paginating, the button intelligently hides itself.
* **UI integration:** The script uses CSTracker.gg's native CSS classes to render the control panel in the existing dark layout.

### Default and custom search presets

The script includes seven predefined Regex parameters targeting standard Counter-Strike chat patterns:

* **Slurs and hate speech**
* **Toxicity** (standard insults and swearing)
* **Hack accusations** (wh, aimbot, toggled)
* **URLs and IPs** (Discord links, Twitch URLs, server addresses)
* **Excuses** (lag, subtick, rng)
* **Bad manners** (ez, tutorial, uninstall)
* **Sportsmanship** (gg, glhf, ns; configured to exclude "gg ez")

Users can type a custom query and click **Save Preset**. The script stores this string in the browser's `localStorage`.

### Data processing

The script executes entirely client-side.

* It makes zero third-party API calls (pagination fetching relies solely on native CSTracker endpoints).
* It fetches no external JavaScript libraries.
* It writes custom presets and export configurations directly to `localStorage`.

### Custom language presets and regular expression tools

The default filters target English strings. The script's search engine processes standard JavaScript regular expressions, allowing users to define matching parameters for Cyrillic, extended Latin, or any other character set.

Users unfamiliar with regex syntax can build and validate patterns using external environments before saving them to `localStorage`:

* [Regex101](https://regex101.com/): Tests patterns against sample text and isolates syntax errors.
* [RegExr](https://regexr.com/): Provides a visual reference for character classes and capture groups.
* [Regex Generator](https://regex-generator.olafneumann.org/): Converts literal text strings into functional regex formats.

Large language models can also generate these strings. Input a strict set of constraints to get a functional pattern. Use this exact prompt structure:

> Generate a JavaScript-compatible regular expression to match toxic vocabulary in [Language]. Target variations of [Word 1], [Word 2], and [Word 3]. Use word boundaries (\b) and output a single-line string.

Copy the output, paste it into the CSTracker search box, check the **Regex** toggle, and click **Save Preset**.

### Call for contributors

I plan to expand the default preset list to support multiple regions natively. If you are a native speaker of Russian, Chinese, Polish, Portuguese, Spanish, or another language common on CS2 servers, you can submit your custom regex lists. will verify the syntax, integrate the patterns into the default release, and credit you unless you opt out. This open submission policy also applies to users writing expanded English patterns.

### License & Contributing

This project is licensed under **All Rights Reserved**. 

You are free to install and use this script for personal use. However, you may not copy, modify, distribute, or re-upload this script (or derivative works) to GreasyFork, GitHub, or any other platform without explicit permission. 

**I welcome and encourage contributions!** If you have a feature idea, bug fix, or want to add a custom regex preset for your language, please fork the [official GitHub repository](https://github.com/tomini/CSTracker-Chat-Inspector) and submit a Pull Request. All accepted contributions will be fully credited.