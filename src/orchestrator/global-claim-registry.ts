export class GlobalClaimRegistry {
  private readonly claims = new Map<string, string>()

  claim(issueId: string, ownerId: string): boolean {
    const current = this.claims.get(issueId)
    if (current && current !== ownerId) {
      return false
    }

    this.claims.set(issueId, ownerId)
    return true
  }

  release(issueId: string, ownerId: string): void {
    if (this.claims.get(issueId) === ownerId) {
      this.claims.delete(issueId)
    }
  }

  isClaimedBy(issueId: string, ownerId: string): boolean {
    return this.claims.get(issueId) === ownerId
  }
}
