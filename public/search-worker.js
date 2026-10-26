import { searchPredicate } from "./search-model.js";
self.onmessage = ({ data }) => {
  try {
    const predicate = searchPredicate(data.options);
    self.postMessage({
      indexes: data.entries.flatMap((entry, index) =>
        predicate(entry) ? [index] : [],
      ),
    });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
