use anyhow::{Context, Result};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

pub struct PiperLexicon {
    tokens: HashMap<String, i64>,
    words: HashMap<String, Vec<i64>>,
    max_word_chars: usize,
    bos: i64,
    eos: i64,
}

impl PiperLexicon {
    pub fn load(model_dir: &Path) -> Result<Self> {
        let tokens = read_tokens(&model_dir.join("tokens.txt"))?;
        let (words, max_word_chars) = read_lexicon(&model_dir.join("lexicon.txt"), &tokens)?;
        let bos = require_token(&tokens, "^")?;
        let eos = require_token(&tokens, "$")?;
        Ok(Self {
            tokens,
            words,
            max_word_chars,
            bos,
            eos,
        })
    }

    pub fn tokenize(&self, text: &str) -> Result<Vec<i64>> {
        let normalized = text.nfkc().collect::<String>().to_lowercase();
        let chars = normalized.chars().collect::<Vec<_>>();
        let mut ids = Vec::new();
        let mut index = 0;

        while index < chars.len() {
            let upper = usize::min(chars.len(), index + self.max_word_chars);
            let mut matched = false;
            for end in (index + 1..=upper).rev() {
                let word = chars[index..end].iter().collect::<String>();
                if let Some(word_ids) = self.words.get(&word) {
                    ids.extend_from_slice(word_ids);
                    index = end;
                    matched = true;
                    break;
                }
            }
            if matched {
                continue;
            }

            let character = chars[index].to_string();
            if !chars[index].is_whitespace()
                && let Some(token_id) = self.tokens.get(&character)
            {
                ids.push(*token_id);
            }
            index += 1;
        }

        if ids.is_empty() {
            anyhow::bail!("text does not contain any pronounceable Chinese tokens");
        }
        Ok(std::iter::once(self.bos)
            .chain(ids)
            .chain(std::iter::once(self.eos))
            .collect())
    }
}

fn read_tokens(path: &Path) -> Result<HashMap<String, i64>> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("failed to read TTS tokens: {}", path.display()))?;
    let mut tokens = HashMap::new();
    for line in contents.lines() {
        let mut parts = line.split_whitespace();
        let Some(token) = parts.next() else {
            continue;
        };
        let Some(raw_id) = parts.next() else {
            continue;
        };
        let id = raw_id
            .parse::<i64>()
            .with_context(|| format!("invalid token id in {}: {raw_id}", path.display()))?;
        tokens.insert(token.to_owned(), id);
    }
    Ok(tokens)
}

fn read_lexicon(
    path: &Path,
    tokens: &HashMap<String, i64>,
) -> Result<(HashMap<String, Vec<i64>>, usize)> {
    let contents = fs::read_to_string(path)
        .with_context(|| format!("failed to read TTS lexicon: {}", path.display()))?;
    let mut words = HashMap::new();
    let mut max_word_chars = 1;
    for line in contents.lines() {
        let mut parts = line.split_whitespace();
        let Some(word) = parts.next() else {
            continue;
        };
        let ids = parts
            .filter_map(|token| tokens.get(token).copied())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            continue;
        }
        max_word_chars = max_word_chars.max(word.chars().count());
        words.insert(word.to_lowercase(), ids);
    }
    Ok((words, max_word_chars))
}

fn require_token(tokens: &HashMap<String, i64>, token: &str) -> Result<i64> {
    tokens
        .get(token)
        .copied()
        .with_context(|| format!("TTS token file is missing {token:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn tokenizes_phrases_and_punctuation() {
        let directory = tempfile::tempdir().unwrap();
        let mut tokens = fs::File::create(directory.path().join("tokens.txt")).unwrap();
        writeln!(tokens, "^\t1").unwrap();
        writeln!(tokens, "$\t2").unwrap();
        writeln!(tokens, "。\t3").unwrap();
        writeln!(tokens, "h\t4").unwrap();
        writeln!(tokens, "ao\t5").unwrap();
        writeln!(tokens, "3\t6").unwrap();
        writeln!(tokens, "_\t0").unwrap();
        fs::write(directory.path().join("lexicon.txt"), "好 h ao 3 _\n").unwrap();

        let lexicon = PiperLexicon::load(directory.path()).unwrap();
        assert_eq!(lexicon.tokenize("好。").unwrap(), vec![1, 4, 5, 6, 0, 3, 2]);
    }
}
