export async function inTransaction<T>(work: () => Promise<T>): Promise<T> { return work(); }
