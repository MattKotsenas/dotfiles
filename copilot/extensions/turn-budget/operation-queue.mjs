export function createOperationQueue(onFailure) {
  let failed = false;
  let chain = Promise.resolve();

  return {
    enqueue(operation) {
      if (failed) {
        return chain;
      }

      chain = chain
        .then(async () => {
          if (!failed) {
            await operation();
          }
        })
        .catch(async (error) => {
          if (!failed) {
            failed = true;
            await onFailure(error);
          }
        });

      return chain;
    },

    flush() {
      return chain;
    },
  };
}
