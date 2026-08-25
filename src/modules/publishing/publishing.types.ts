export interface PublicRecipeDto {
  components: Array<{
    id: string;
    name: string;
  }>;
  id: string;
  creatorName?: string;
  ingredients: Array<{
    componentId: string;
    id: string;
    text: string;
  }>;
  steps: Array<{
    componentId: string;
    id: string;
    instruction: string;
  }>;
  title: string;
  yieldText: string;
}

export interface PublicCollectionRecipeDto {
  id: string;
  title: string;
  yieldText: string;
}

export interface PublicCollectionDto {
  description: string;
  id: string;
  recipes: PublicCollectionRecipeDto[];
  title: string;
}
