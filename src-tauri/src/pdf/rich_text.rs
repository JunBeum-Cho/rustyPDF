//! Tiny HTML walker for text-annotation export.
//!
//! Parses the editor's contenteditable output (a constrained subset of
//! HTML produced by `document.execCommand` with `styleWithCSS=true`)
//! into a flat list of styled runs grouped by visual line. The flatten
//! stage in `annotations.rs` then emits one PDF text object per run so
//! per-range bold / italic / color / size carry into the PDF.
//!
//! Why not html5ever? The editor's output uses ~10 tag names total and
//! always closes its own tags; we don't need a full HTML5 conformance
//! pass. Pulling html5ever in transitively would add ~100k lines of dep
//! code for a job a 200-line state machine handles fine.
//!
//! Tags handled:
//!   - block: `<div>`, `<p>` — open inserts a line break before any
//!     prior content, close is a no-op
//!   - explicit break: `<br>`
//!   - inline weight/style: `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`
//!   - inline span: `<span style="...">` — parses font-family,
//!     font-size, font-weight, font-style, text-decoration, color
//!   - legacy: `<font face=... color=... size=...>`
//! Anything else opens a transparent style frame so close still pops.

#[derive(Clone, Debug)]
pub struct RunStyle {
    pub color: String,
    pub opacity: f32,
    pub font_size: f32,
    pub font_family: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
}

#[derive(Debug)]
pub struct TextRun {
    pub text: String,
    pub style: RunStyle,
}

#[derive(Debug, Default)]
pub struct TextLine {
    pub runs: Vec<TextRun>,
}

impl TextLine {
    fn is_empty(&self) -> bool {
        self.runs.iter().all(|r| r.text.is_empty())
    }
}

pub fn parse_html(html: &str, base: RunStyle) -> Vec<TextLine> {
    let chars: Vec<char> = html.chars().collect();
    let mut lines: Vec<TextLine> = vec![TextLine::default()];
    let mut style_stack: Vec<RunStyle> = vec![base];
    let mut buf = String::new();

    let push_text = |buf: &mut String,
                     lines: &mut Vec<TextLine>,
                     style_stack: &Vec<RunStyle>| {
        if buf.is_empty() {
            return;
        }
        let style = style_stack.last().expect("style stack non-empty").clone();
        lines
            .last_mut()
            .expect("lines non-empty")
            .runs
            .push(TextRun {
                text: std::mem::take(buf),
                style,
            });
    };

    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '<' {
            // Bail early on anomalous "<" (like `2 < 3` typed without escaping).
            let close = match find_char(&chars, i + 1, '>') {
                Some(p) => p,
                None => {
                    buf.push(c);
                    i += 1;
                    continue;
                }
            };
            push_text(&mut buf, &mut lines, &style_stack);
            let tag_chars = &chars[i + 1..close];
            handle_tag(tag_chars, &mut style_stack, &mut lines);
            i = close + 1;
        } else if c == '&' {
            // Entities are short, scan max 10 chars for ';'. Anything longer is
            // not an HTML entity — treat the '&' as literal.
            let max = (i + 12).min(chars.len());
            let mut found_semi = None;
            for j in (i + 1)..max {
                if chars[j] == ';' {
                    found_semi = Some(j);
                    break;
                }
                if chars[j] == '<' || chars[j] == '&' {
                    break;
                }
            }
            if let Some(end) = found_semi {
                let entity: String = chars[i..=end].iter().collect();
                buf.push_str(&decode_entity(&entity));
                i = end + 1;
            } else {
                buf.push('&');
                i += 1;
            }
        } else {
            buf.push(c);
            i += 1;
        }
    }
    push_text(&mut buf, &mut lines, &style_stack);

    // Drop trailing empty lines that come from `<div>...</div>` at the end of
    // the html — the open created a leading blank line that we never filled.
    while lines.len() > 1 && lines.last().map_or(true, |l| l.is_empty()) {
        lines.pop();
    }
    lines
}

fn find_char(chars: &[char], from: usize, target: char) -> Option<usize> {
    chars[from..]
        .iter()
        .position(|&c| c == target)
        .map(|p| p + from)
}

fn handle_tag(
    tag_chars: &[char],
    style_stack: &mut Vec<RunStyle>,
    lines: &mut Vec<TextLine>,
) {
    if tag_chars.is_empty() {
        return;
    }
    if tag_chars[0] == '!' || tag_chars[0] == '?' {
        // Comment / processing instruction / doctype — ignore entirely.
        return;
    }
    let is_close = tag_chars[0] == '/';
    let body: String = if is_close {
        tag_chars[1..].iter().collect()
    } else {
        tag_chars.iter().collect()
    };

    let body = body.trim_end_matches('/').trim();
    let (name, attrs_str) = match body.find(|c: char| c.is_whitespace()) {
        Some(idx) => (&body[..idx], body[idx..].trim()),
        None => (body, ""),
    };
    let name = name.to_ascii_lowercase();

    if is_close {
        // Block close doesn't add a break — the next open inserts one if
        // needed. Always pop a frame so opens and closes balance.
        if style_stack.len() > 1 {
            style_stack.pop();
        }
        return;
    }

    if name == "br" {
        lines.push(TextLine::default());
        return;
    }
    if matches!(name.as_str(), "img" | "hr" | "input" | "meta" | "link") {
        // Void elements: no style frame, no break.
        return;
    }
    if matches!(name.as_str(), "div" | "p") {
        if let Some(last) = lines.last() {
            if !last.is_empty() {
                lines.push(TextLine::default());
            }
        }
        // Block elements still cascade their own style (e.g. <div style=...>).
        let mut new_style = style_stack.last().cloned().unwrap_or_else(default_style);
        apply_attr_styles(attrs_str, &mut new_style);
        style_stack.push(new_style);
        return;
    }

    let mut new_style = style_stack.last().cloned().unwrap_or_else(default_style);
    match name.as_str() {
        "b" | "strong" => new_style.bold = true,
        "i" | "em" => new_style.italic = true,
        "u" => new_style.underline = true,
        "span" | "font" => apply_attr_styles(attrs_str, &mut new_style),
        _ => { /* unknown tag — neutral frame */ }
    }
    style_stack.push(new_style);
}

fn default_style() -> RunStyle {
    RunStyle {
        color: "#000000".to_string(),
        opacity: 1.0,
        font_size: 16.0,
        font_family: None,
        bold: false,
        italic: false,
        underline: false,
    }
}

fn apply_attr_styles(attrs_str: &str, style: &mut RunStyle) {
    for (key, value) in parse_attrs(attrs_str) {
        match key.as_str() {
            "style" => apply_inline_css(&value, style),
            "color" => {
                if let Some(hex) = parse_color(&value) {
                    style.color = hex;
                }
            }
            "face" => {
                if !value.is_empty() {
                    style.font_family = Some(value);
                }
            }
            "size" => {
                if let Ok(n) = value.parse::<u8>() {
                    let table = [9.0, 10.0, 13.0, 16.0, 18.0, 24.0, 32.0];
                    let idx = (n.clamp(1, 7) - 1) as usize;
                    style.font_size = table[idx];
                }
            }
            _ => {}
        }
    }
}

fn apply_inline_css(css: &str, style: &mut RunStyle) {
    for decl in css.split(';') {
        let Some((k, v)) = decl.split_once(':') else { continue };
        let key = k.trim().to_ascii_lowercase();
        let value = v.trim().trim_matches('"').trim_matches('\'');
        match key.as_str() {
            "color" => {
                if let Some(hex) = parse_color(value) {
                    style.color = hex;
                }
            }
            "font-family" => {
                if !value.is_empty() {
                    style.font_family = Some(value.to_string());
                }
            }
            "font-size" => {
                if let Some(px) = parse_size_px(value) {
                    style.font_size = px;
                }
            }
            "font-weight" => {
                let v_lc = value.to_ascii_lowercase();
                if v_lc == "bold" || v_lc == "bolder" {
                    style.bold = true;
                } else if v_lc == "normal" || v_lc == "lighter" {
                    style.bold = false;
                } else if let Ok(n) = v_lc.parse::<u32>() {
                    style.bold = n >= 600;
                }
            }
            "font-style" => {
                let v_lc = value.to_ascii_lowercase();
                style.italic = v_lc == "italic" || v_lc == "oblique";
            }
            "text-decoration" | "text-decoration-line" => {
                let v_lc = value.to_ascii_lowercase();
                if v_lc.contains("underline") {
                    style.underline = true;
                } else if v_lc.contains("none") {
                    style.underline = false;
                }
            }
            _ => {}
        }
    }
}

fn parse_size_px(value: &str) -> Option<f32> {
    let v = value.trim().to_ascii_lowercase();
    if let Some(num) = v.strip_suffix("px") {
        return num.trim().parse().ok();
    }
    if let Some(num) = v.strip_suffix("pt") {
        // 1pt = 1.333…px under the common 96dpi assumption browsers use.
        return num.trim().parse::<f32>().ok().map(|p| p * 96.0 / 72.0);
    }
    if let Some(num) = v.strip_suffix("em") {
        return num.trim().parse::<f32>().ok().map(|e| e * 16.0);
    }
    v.parse().ok()
}

fn parse_color(value: &str) -> Option<String> {
    let v = value.trim();
    if let Some(hex) = v.strip_prefix('#') {
        if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(format!("#{}", hex));
        }
        if hex.len() == 3 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            // Expand `#abc` to `#aabbcc`.
            let bytes = hex.as_bytes();
            return Some(format!(
                "#{0}{0}{1}{1}{2}{2}",
                bytes[0] as char, bytes[1] as char, bytes[2] as char
            ));
        }
        return None;
    }
    if let Some(inner) = v
        .strip_prefix("rgb(")
        .and_then(|s| s.strip_suffix(')'))
        .or_else(|| v.strip_prefix("rgba(").and_then(|s| s.strip_suffix(')')))
    {
        let parts: Vec<&str> = inner.split(',').collect();
        if parts.len() >= 3 {
            let r: u8 = parts[0].trim().parse().ok()?;
            let g: u8 = parts[1].trim().parse().ok()?;
            let b: u8 = parts[2].trim().parse().ok()?;
            return Some(format!("#{:02x}{:02x}{:02x}", r, g, b));
        }
    }
    None
}

fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let mut chars = s.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        // attribute name
        let mut name = String::new();
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() || c == '=' || c == '>' {
                break;
            }
            name.push(c);
            chars.next();
        }
        if name.is_empty() {
            // Defensive: skip a stray char rather than spinning.
            chars.next();
            continue;
        }
        // skip whitespace
        while let Some(&c) = chars.peek() {
            if !c.is_whitespace() {
                break;
            }
            chars.next();
        }
        let mut value = String::new();
        if let Some(&'=') = chars.peek() {
            chars.next();
            while let Some(&c) = chars.peek() {
                if !c.is_whitespace() {
                    break;
                }
                chars.next();
            }
            if let Some(&q) = chars.peek() {
                if q == '"' || q == '\'' {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == q {
                            break;
                        }
                        value.push(c);
                    }
                } else {
                    while let Some(&c) = chars.peek() {
                        if c.is_whitespace() || c == '>' {
                            break;
                        }
                        value.push(c);
                        chars.next();
                    }
                }
            }
        }
        result.push((name.to_ascii_lowercase(), decode_entities(&value)));
    }
    result
}

fn decode_entity(entity: &str) -> String {
    match entity {
        "&amp;" => "&".to_string(),
        "&lt;" => "<".to_string(),
        "&gt;" => ">".to_string(),
        "&quot;" => "\"".to_string(),
        "&apos;" => "'".to_string(),
        "&nbsp;" => "\u{00a0}".to_string(),
        _ => {
            if let Some(num) = entity.strip_prefix("&#").and_then(|s| s.strip_suffix(';')) {
                if let Some(hex) = num.strip_prefix(['x', 'X']) {
                    if let Ok(code) = u32::from_str_radix(hex, 16) {
                        if let Some(c) = char::from_u32(code) {
                            return c.to_string();
                        }
                    }
                } else if let Ok(code) = num.parse::<u32>() {
                    if let Some(c) = char::from_u32(code) {
                        return c.to_string();
                    }
                }
            }
            entity.to_string()
        }
    }
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' {
            let max = (i + 12).min(chars.len());
            let mut end = None;
            for j in (i + 1)..max {
                if chars[j] == ';' {
                    end = Some(j);
                    break;
                }
                if chars[j] == '&' || chars[j] == '<' {
                    break;
                }
            }
            if let Some(p) = end {
                let entity: String = chars[i..=p].iter().collect();
                out.push_str(&decode_entity(&entity));
                i = p + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> RunStyle {
        RunStyle {
            color: "#000".into(),
            opacity: 1.0,
            font_size: 16.0,
            font_family: None,
            bold: false,
            italic: false,
            underline: false,
        }
    }

    #[test]
    fn plain_text() {
        let lines = parse_html("hello", base());
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].runs[0].text, "hello");
    }

    #[test]
    fn br_splits_lines() {
        let lines = parse_html("a<br>b", base());
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].runs[0].text, "a");
        assert_eq!(lines[1].runs[0].text, "b");
    }

    #[test]
    fn div_blocks_split() {
        let lines = parse_html("<div>a</div><div>b</div>", base());
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].runs[0].text, "a");
        assert_eq!(lines[1].runs[0].text, "b");
    }

    #[test]
    fn bold_inline() {
        let lines = parse_html("<b>hi</b>", base());
        assert!(lines[0].runs[0].style.bold);
    }

    #[test]
    fn span_font_weight() {
        let lines = parse_html("<span style=\"font-weight: 700\">x</span>", base());
        assert!(lines[0].runs[0].style.bold);
    }

    #[test]
    fn span_font_size_px() {
        let lines = parse_html("<span style=\"font-size: 24px\">x</span>", base());
        assert!((lines[0].runs[0].style.font_size - 24.0).abs() < 0.01);
    }

    #[test]
    fn entities_decoded() {
        let lines = parse_html("a&amp;b", base());
        assert_eq!(lines[0].runs[0].text, "a&b");
    }
}
