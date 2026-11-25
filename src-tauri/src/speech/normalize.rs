//! Turn written text into words a voice can say.
//!
//! The pronunciation step only knows words, so numbers, times, money,
//! percentages, ordinals, and a few symbols are spelled out here first.
//! Anything this does not recognise is left alone.

use std::sync::LazyLock;

use regex::{Captures, Regex};

const ONES: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [(u64, &str); 4] = [
    (1_000_000_000_000, "trillion"),
    (1_000_000_000, "billion"),
    (1_000_000, "million"),
    (1_000, "thousand"),
];

fn below_hundred(n: u64) -> String {
    if n < 20 {
        ONES[n as usize].to_string()
    } else if n % 10 == 0 {
        TENS[(n / 10) as usize].to_string()
    } else {
        format!("{}-{}", TENS[(n / 10) as usize], ONES[(n % 10) as usize])
    }
}

fn below_thousand(n: u64) -> String {
    match (n / 100, n % 100) {
        (0, r) => below_hundred(r),
        (h, 0) => format!("{} hundred", ONES[h as usize]),
        (h, r) => format!("{} hundred {}", ONES[h as usize], below_hundred(r)),
    }
}

/// Cardinal number in words, e.g. 1234 -> "one thousand two hundred thirty-four".
pub fn cardinal(mut n: u64) -> String {
    if n == 0 {
        return "zero".into();
    }
    let mut parts = Vec::new();
    for (size, name) in SCALES {
        if n >= size {
            parts.push(format!("{} {}", cardinal(n / size), name));
            n %= size;
        }
    }
    if n > 0 {
        parts.push(below_thousand(n));
    }
    parts.join(" ")
}

/// Ordinal number in words, e.g. 21 -> "twenty-first".
pub fn ordinal(n: u64) -> String {
    let words = cardinal(n);
    let (head, last) = match words.rfind([' ', '-']) {
        Some(i) => (&words[..=i], &words[i + 1..]),
        None => ("", words.as_str()),
    };
    let last = match last {
        "one" => "first".to_string(),
        "two" => "second".to_string(),
        "three" => "third".to_string(),
        "five" => "fifth".to_string(),
        "eight" => "eighth".to_string(),
        "nine" => "ninth".to_string(),
        "twelve" => "twelfth".to_string(),
        w if w.ends_with('y') => format!("{}ieth", &w[..w.len() - 1]),
        w => format!("{w}th"),
    };
    format!("{head}{last}")
}

/// A four-digit year read the usual way: 1984 -> "nineteen eighty-four",
/// 2006 -> "two thousand six", 2026 -> "twenty twenty-six".
pub fn year(n: u64) -> String {
    let (hi, lo) = (n / 100, n % 100);
    if (2000..2010).contains(&n) || lo == 0 && n % 1000 == 0 {
        return cardinal(n);
    }
    let tail = match lo {
        0 => "hundred".to_string(),
        1..=9 => format!("oh {}", ONES[lo as usize]),
        _ => below_hundred(lo),
    };
    format!("{} {}", below_hundred(hi), tail)
}

fn digits(s: &str) -> u64 {
    s.chars().filter(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0)
}

/// Words for a number as written, e.g. "1,250" or "3.75".
fn number(written: &str) -> String {
    match written.split_once('.') {
        Some((whole, frac)) if !frac.is_empty() => {
            let frac: Vec<&str> = frac.chars().filter_map(|c| c.to_digit(10)).map(|d| ONES[d as usize]).collect();
            format!("{} point {}", cardinal(digits(whole)), frac.join(" "))
        }
        _ => cardinal(digits(written)),
    }
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{} {}", cardinal(n), if n == 1 { one } else { many })
}

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}

re!(TIME, r"\b(\d{1,2}):(\d{2})\b");
re!(AM_PM, r"(?i)\b([ap])\.?\s?m\.?(\W|$)");
re!(MONEY, r"([$£€])\s?(\d[\d,]*)(?:\.(\d{1,2}))?\b(?:\s?(million|billion|trillion)\b)?");
re!(PERCENT, r"(\d[\d,]*(?:\.\d+)?)\s?%");
re!(ORDINAL, r"\b(\d+)(?:st|nd|rd|th)\b");
re!(YEAR, r"\b(1[1-9]\d\d|20\d\d)s?\b");
re!(DECIMAL, r"\b\d[\d,]*\.\d+\b");
re!(INTEGER, r"\b\d{1,3}(?:,\d{3})+\b|\b\d+\b");

/// Spell out numbers and symbols so every part of `text` can be spoken.
pub fn normalize(text: &str) -> String {
    let t = text.replace(['\u{2019}', '\u{2018}'], "'").replace('&', " and ");

    let t = TIME.replace_all(&t, |c: &Captures| {
        let (h, m) = (digits(&c[1]), digits(&c[2]));
        if h > 24 || m > 59 {
            return c[0].to_string();
        }
        match m {
            0 => format!("{} o'clock", cardinal(h)),
            1..=9 => format!("{} oh {}", cardinal(h), ONES[m as usize]),
            _ => format!("{} {}", cardinal(h), below_hundred(m)),
        }
    });
    let t = AM_PM.replace_all(&t, |c: &Captures| format!("{} M{}", c[1].to_uppercase(), &c[2]));

    let t = MONEY.replace_all(&t, |c: &Captures| {
        let (unit, units, cent, cents) = match &c[1] {
            "£" => ("pound", "pounds", "penny", "pence"),
            "€" => ("euro", "euros", "cent", "cents"),
            _ => ("dollar", "dollars", "cent", "cents"),
        };
        if let Some(scale) = c.get(4) {
            let amount = match c.get(3) {
                Some(f) => number(&format!("{}.{}", &c[2], f.as_str())),
                None => cardinal(digits(&c[2])),
            };
            return format!("{amount} {} {units}", scale.as_str());
        }
        let whole = digits(&c[2]);
        let frac = c.get(3).map(|f| {
            let v = digits(f.as_str());
            if f.as_str().len() == 1 { v * 10 } else { v }
        });
        match frac {
            Some(f) if f > 0 && whole > 0 => format!("{}, {}", plural(whole, unit, units), plural(f, cent, cents)),
            Some(f) if f > 0 => plural(f, cent, cents),
            _ => plural(whole, unit, units),
        }
    });

    let t = PERCENT.replace_all(&t, |c: &Captures| format!("{} percent", number(&c[1])));
    let t = ORDINAL.replace_all(&t, |c: &Captures| ordinal(digits(&c[1])));
    let t = YEAR.replace_all(&t, |c: &Captures| {
        let words = year(digits(&c[1]));
        if c[0].ends_with('s') {
            match words.strip_suffix('y') {
                Some(stem) => format!("{stem}ies"),
                None => format!("{words}s"),
            }
        } else {
            words
        }
    });
    let t = DECIMAL.replace_all(&t, |c: &Captures| number(&c[0]));
    let t = INTEGER.replace_all(&t, |c: &Captures| number(&c[0]));
    t.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        assert_eq!(cardinal(0), "zero");
        assert_eq!(cardinal(15), "fifteen");
        assert_eq!(cardinal(42), "forty-two");
        assert_eq!(cardinal(100), "one hundred");
        assert_eq!(cardinal(1_234), "one thousand two hundred thirty-four");
        assert_eq!(cardinal(15_000_000_000), "fifteen billion");
        assert_eq!(ordinal(1), "first");
        assert_eq!(ordinal(21), "twenty-first");
        assert_eq!(ordinal(40), "fortieth");
        assert_eq!(ordinal(112), "one hundred twelfth");
        assert_eq!(year(1984), "nineteen eighty-four");
        assert_eq!(year(1905), "nineteen oh five");
        assert_eq!(year(1900), "nineteen hundred");
        assert_eq!(year(2000), "two thousand");
        assert_eq!(year(2006), "two thousand six");
        assert_eq!(year(2026), "twenty twenty-six");
    }

    #[test]
    fn sentences() {
        let cases = [
            ("At 6:30 a.m. we left.", "At six thirty A M we left."),
            ("Meet at 9:05 pm", "Meet at nine oh five P M"),
            ("It starts at 7:00.", "It starts at seven o'clock."),
            ("It cost $4.99.", "It cost four dollars, ninety-nine cents."),
            ("Only $1 or £3.50 or $0.25", "Only one dollar or three pounds, fifty pence or twenty-five cents"),
            ("A $2.5 billion deal", "A two point five billion dollars deal"),
            ("Up 3.5% today", "Up three point five percent today"),
            ("The 21st time", "The twenty-first time"),
            ("In 2026 and the 1990s", "In twenty twenty-six and the nineteen nineties"),
            ("About 15 billion miles", "About fifteen billion miles"),
            ("1,250 people", "one thousand two hundred fifty people"),
            ("Rock & roll", "Rock  and  roll"),
            ("Voyager 1 is far.", "Voyager one is far."),
        ];
        for (input, want) in cases {
            assert_eq!(normalize(input), want, "input: {input}");
        }
    }
}
