use std::collections::HashSet;

use emojis::{Emoji, Group};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum EmojiCategory {
    #[default]
    All,
    Smileys,
    People,
    Nature,
    Food,
    Travel,
    Activities,
    Objects,
    Symbols,
    Flags,
}

impl EmojiCategory {
    pub const ALL: [Self; 10] = [
        Self::All,
        Self::Smileys,
        Self::People,
        Self::Nature,
        Self::Food,
        Self::Travel,
        Self::Activities,
        Self::Objects,
        Self::Symbols,
        Self::Flags,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::All => "All",
            Self::Smileys => "😀",
            Self::People => "👋",
            Self::Nature => "🐻",
            Self::Food => "🍕",
            Self::Travel => "🚗",
            Self::Activities => "⚽",
            Self::Objects => "💡",
            Self::Symbols => "❤️",
            Self::Flags => "🏳️",
        }
    }

    fn group(self) -> Option<Group> {
        match self {
            Self::All => None,
            Self::Smileys => Some(Group::SmileysAndEmotion),
            Self::People => Some(Group::PeopleAndBody),
            Self::Nature => Some(Group::AnimalsAndNature),
            Self::Food => Some(Group::FoodAndDrink),
            Self::Travel => Some(Group::TravelAndPlaces),
            Self::Activities => Some(Group::Activities),
            Self::Objects => Some(Group::Objects),
            Self::Symbols => Some(Group::Symbols),
            Self::Flags => Some(Group::Flags),
        }
    }
}

/// Returns the complete Unicode Emoji 17 catalog known by `emojis`, including
/// every skin-tone variant. Filtering is done once per query/category change;
/// rendering remains virtualized by the caller.
pub fn filtered(category: EmojiCategory, query: &str) -> Vec<&'static Emoji> {
    let query = query.trim().to_lowercase();
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for base in emojis::iter() {
        if category.group().is_some_and(|group| base.group() != group) {
            continue;
        }
        let matches = query.is_empty()
            || base.name().contains(&query)
            || base.shortcodes().any(|code| code.contains(&query));
        if !matches {
            continue;
        }
        if let Some(tones) = base.skin_tones() {
            for emoji in tones {
                if seen.insert(emoji.as_str()) {
                    result.push(emoji);
                }
            }
        } else if seen.insert(base.as_str()) {
            result.push(base);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_current_unicode_catalog_and_skin_tones() {
        let all = filtered(EmojiCategory::All, "");
        assert!(all.len() > emojis::iter().count());
        assert!(all.iter().any(|emoji| emoji.as_str() == "🫩"));
        assert!(all.iter().any(|emoji| emoji.as_str() == "👋🏿"));
    }

    #[test]
    fn search_uses_names_and_shortcodes() {
        let rocket = filtered(EmojiCategory::All, "rocket");
        assert!(rocket.iter().any(|emoji| emoji.as_str() == "🚀"));
        assert!(!rocket.iter().any(|emoji| emoji.as_str() == "🍕"));
    }

    #[test]
    fn category_filter_is_applied() {
        let flags = filtered(EmojiCategory::Flags, "");
        assert!(!flags.is_empty());
        assert!(flags.iter().all(|emoji| emoji.group() == Group::Flags));
    }
}
